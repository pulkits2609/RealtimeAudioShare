using System.Text.Json;
using System.Buffers.Binary;
using System.Diagnostics;
using NAudio.CoreAudioApi;
using NAudio.Wave;

internal static class Program
{
    private static readonly BoundedOutput Output = new();
    private static readonly object CaptureLock = new();
    private static IWaveIn? capture;
    private static MMDevice? activeDevice;
    private static int generation;
    private static readonly Guid FloatSubtype = new("00000003-0000-0010-8000-00aa00389b71");

    private static void Emit(object message)
    {
        Output.Control(() => FramedOutput.Control(message));
    }

    private static void Main()
    {
        string? line;
        while ((line = Console.ReadLine()) != null)
        {
            try
            {
                using var json = JsonDocument.Parse(line);
                var root = json.RootElement;
                var requestId = root.TryGetProperty("requestId", out var request) ? request.GetInt32() : 0;
                try
                {
                    switch (root.GetProperty("command").GetString())
                    {
                        case "devices": ListDevices(requestId); break;
                        case "capabilities": Emit(new { type = "capabilities", requestId, processExclusion = ProcessLoopbackCapture.IsSupported, reason = ProcessLoopbackCapture.IsSupported ? null : "Requires Windows build 20348 or newer." }); break;
                        case "start": Start(root.GetProperty("deviceId").GetString() ?? "", requestId,
                            root.TryGetProperty("mode", out var mode) ? mode.GetString() ?? "endpoint" : "endpoint",
                            root.TryGetProperty("targetProcessId", out var pid) ? pid.GetUInt32() : 0); break;
                        case "stop": Stop(); Emit(new { type = "stopped", requestId }); break;
                        default: throw new ArgumentException("Unknown capture command.");
                    }
                }
                catch (Exception error) { Emit(new { type = "error", requestId, message = error.Message }); }
            }
            catch (Exception error) { Emit(new { type = "error", requestId = 0, message = error.Message }); }
        }
        try { Stop(); } finally { Output.Dispose(); }
    }

    private static void ListDevices(int requestId)
    {
        using var enumerator = new MMDeviceEnumerator();
        var devices = enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active);
        var result = devices.Select(device => { using (device) return new { id = device.ID, name = device.FriendlyName }; }).ToArray();
        string? defaultDeviceId = null;
        try { using var defaultDevice = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia); defaultDeviceId = defaultDevice.ID; }
        catch (System.Runtime.InteropServices.COMException) { /* No default endpoint is a valid empty-device state. */ }
        Emit(new { type = "devices", requestId, devices = result, defaultDeviceId });
    }

    private static void Start(string deviceId, int requestId, string mode, uint processId)
    {
        Stop();
        using var enumerator = new MMDeviceEnumerator();
        if (mode is not ("endpoint" or "exclude-self")) throw new ArgumentException("Unknown capture mode.");
        MMDevice? device = mode == "endpoint" ? enumerator.GetDevice(deviceId) : null;
        IWaveIn? next = null;
        try
        {
            if (device != null && device.State != DeviceState.Active) throw new InvalidOperationException("The selected output device is unavailable.");
            next = mode == "exclude-self" ? new ProcessLoopbackCapture(processId) : new OutputCapture(device!);
            var format = next.WaveFormat;
            var isFloat = format.Encoding == WaveFormatEncoding.IeeeFloat || format is WaveFormatExtensible extensible && extensible.SubFormat == FloatSubtype;
            if (isFloat && format.BitsPerSample != 32 || !isFloat && format.BitsPerSample is not (16 or 24 or 32))
                throw new NotSupportedException($"Unsupported output format: {format}");
            var selectedCapture = next;
            var captureGeneration = Volatile.Read(ref generation);
            next.DataAvailable += (_, args) =>
            {
                if (!ReferenceEquals(Volatile.Read(ref capture), selectedCapture) || args.BytesRecorded <= 0 || args.BytesRecorded > 38400) return;
                var raw = new byte[args.BytesRecorded];
                Buffer.BlockCopy(args.Buffer, 0, raw, 0, raw.Length);
                var created = Stopwatch.GetTimestamp();
                Output.Audio(() =>
                {
                    if (Volatile.Read(ref generation) != captureGeneration || Stopwatch.GetElapsedTime(created).TotalMilliseconds > 100) return;
                    var bytesPerSample = format.BitsPerSample / 8;
                    var sampleCount = raw.Length / bytesPerSample;
                    var bytes = new byte[sampleCount * sizeof(float)];
                    for (int index = 0, offset = 0; index < sampleCount; index++, offset += bytesPerSample)
                    {
                        float value;
                        if (isFloat) value = BitConverter.ToSingle(raw, offset);
                        else if (bytesPerSample == 2) value = BitConverter.ToInt16(raw, offset) / 32768f;
                        else if (bytesPerSample == 3)
                        {
                            var pcm = raw[offset] | raw[offset + 1] << 8 | raw[offset + 2] << 16;
                            if ((pcm & 0x800000) != 0) pcm |= unchecked((int)0xff000000);
                            value = pcm / 8388608f;
                        }
                        else value = BitConverter.ToInt32(raw, offset) / 2147483648f;
                        BinaryPrimitives.WriteSingleLittleEndian(bytes.AsSpan(index * sizeof(float)), float.IsFinite(value) ? Math.Clamp(value, -1f, 1f) : 0);
                    }
                    FramedOutput.Audio(bytes, format.SampleRate, format.Channels);
                });
            };
            next.RecordingStopped += (_, args) =>
            {
                if (args.Exception != null && ReferenceEquals(Volatile.Read(ref capture), selectedCapture))
                    Emit(new { type = "error", requestId = 0, message = args.Exception.Message });
            };
            lock (CaptureLock) { activeDevice = device; capture = next; }
            next.StartRecording();
            Emit(new { type = "started", requestId, channels = format.Channels, sampleRate = format.SampleRate });
        }
        catch
        {
            lock (CaptureLock) { Interlocked.Increment(ref generation); capture = null; activeDevice = null; }
            next?.Dispose();
            device?.Dispose();
            throw;
        }
    }

    private static void Stop()
    {
        IWaveIn? previous;
        MMDevice? device;
        lock (CaptureLock) { Interlocked.Increment(ref generation); previous = capture; device = activeDevice; capture = null; activeDevice = null; }
        try { if (previous != null) { try { previous.StopRecording(); } finally { previous.Dispose(); } } }
        finally { device?.Dispose(); }
    }
}

internal sealed class OutputCapture : WasapiCapture
{
    public OutputCapture(MMDevice device) : base(device, useEventSync: true, audioBufferMillisecondsLength: 20)
    {
        WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(48000, 2);
    }

    protected override AudioClientStreamFlags GetAudioClientStreamFlags() =>
        base.GetAudioClientStreamFlags() | AudioClientStreamFlags.Loopback;
}
