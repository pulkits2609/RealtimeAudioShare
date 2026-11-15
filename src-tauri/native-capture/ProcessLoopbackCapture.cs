using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;
using NAudio.Wave;

// Windows ApplicationLoopback API: https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/
// This virtual device mixes all endpoints and excludes the selected process AND its descendants.
public sealed class ProcessLoopbackCapture : IWaveIn
{
    public static bool IsSupported => OperatingSystem.IsWindowsVersionAtLeast(10, 0, 20348);
    public WaveFormat WaveFormat { get; set; } = WaveFormat.CreateIeeeFloatWaveFormat(48000, 2);
    public event EventHandler<WaveInEventArgs>? DataAvailable;
    public event EventHandler<StoppedEventArgs>? RecordingStopped;
    private readonly uint processId;
    private readonly ManualResetEvent stop = new(false);
    private Thread? worker;
    private AudioClient? client;
    private AutoResetEvent? ready;

    public ProcessLoopbackCapture(uint processId)
    {
        if (!IsSupported) throw new PlatformNotSupportedException("Excluding AudioShare playback requires Windows build 20348 or newer. Choose output-device capture with incoming playback disabled.");
        if (processId == 0) throw new ArgumentException("A valid AudioShare process is required.");
        this.processId = processId;
    }

    public void StartRecording()
    {
        if (worker != null) throw new InvalidOperationException("Capture is already running.");
        var activation = new ActivationHandler();
        var parameters = Marshal.AllocHGlobal(12);
        var variant = Marshal.AllocHGlobal(24);
        IActivationOperation? operation = null;
        var stage = "activation";
        try
        {
            // AUDIOCLIENT_ACTIVATION_PARAMS: activation type, PID, EXCLUDE_TARGET_PROCESS_TREE.
            Marshal.Copy(new[] { 1, unchecked((int)processId), 1 }, 0, parameters, 3);
            Marshal.Copy(new byte[24], 0, variant, 24);
            Marshal.WriteInt16(variant, 65); // VT_BLOB
            Marshal.WriteInt32(variant, 8, 12);
            Marshal.WriteIntPtr(variant, 16, parameters);
            var iid = typeof(IAudioClient).GUID;
            Marshal.ThrowExceptionForHR(ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, variant, activation, out operation));
            // The parent bounds command startup to 10 seconds and terminates a stalled helper.
            // Keep activation memory/COM callback alive until completion rather than freeing it on a local timeout.
            client = new AudioClient(activation.Result.Task.GetAwaiter().GetResult());
            stage = "initialization";
            client.Initialize(AudioClientShareMode.Shared,
                AudioClientStreamFlags.Loopback | AudioClientStreamFlags.EventCallback | AudioClientStreamFlags.AutoConvertPcm | AudioClientStreamFlags.SrcDefaultQuality,
                0, 0, WaveFormat, Guid.Empty);
            ready = new AutoResetEvent(false);
            stage = "event registration";
            client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle());
            // Acquire service before starting so startup errors are returned to the caller.
            _ = client.AudioCaptureClient;
            stage = "start";
            client.Start();
            worker = new Thread(ReadPackets) { IsBackground = true, Name = "AudioShare process loopback" };
            worker.Start();
        }
        catch (Exception error) { client?.Dispose(); client = null; ready?.Dispose(); ready = null; throw new InvalidOperationException($"Process exclusion {stage} failed: {error.Message}", error); }
        finally
        {
            if (operation != null) Marshal.ReleaseComObject(operation);
            Marshal.FreeHGlobal(variant); Marshal.FreeHGlobal(parameters);
            GC.KeepAlive(activation);
        }
    }

    private void ReadPackets()
    {
        Exception? failure = null;
        try
        {
            var capture = client!.AudioCaptureClient;
            var handles = new WaitHandle[] { stop, ready! };
            while (WaitHandle.WaitAny(handles, 100) != 0)
            {
                while (!stop.WaitOne(0) && capture.GetNextPacketSize() > 0)
                {
                    var pointer = capture.GetBuffer(out var frames, out var flags);
                    try
                    {
                        // Keep each event bounded to the same maximum as endpoint capture.
                        var remaining = checked(frames * WaveFormat.BlockAlign);
                        for (var offset = 0; offset < remaining; offset += 38400)
                        {
                            var bytes = new byte[Math.Min(38400, remaining - offset)];
                            if ((flags & AudioClientBufferFlags.Silent) == 0) Marshal.Copy(IntPtr.Add(pointer, offset), bytes, 0, bytes.Length);
                            DataAvailable?.Invoke(this, new WaveInEventArgs(bytes, bytes.Length));
                        }
                    }
                    finally { capture.ReleaseBuffer(frames); }
                }
            }
        }
        catch (Exception error) { failure = error; }
        finally { try { client?.Stop(); } catch (Exception error) { failure ??= error; } RecordingStopped?.Invoke(this, new StoppedEventArgs(failure)); }
    }

    public void StopRecording() { stop.Set(); worker?.Join(); worker = null; }
    public void Dispose() { StopRecording(); client?.Dispose(); client = null; ready?.Dispose(); ready = null; stop.Dispose(); }

    [DllImport("Mmdevapi.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern int ActivateAudioInterfaceAsync(string deviceInterfacePath, ref Guid iid, IntPtr activationParams,
        IActivationHandler completionHandler, out IActivationOperation operation);

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivationOperation { void GetActivateResult(out int result, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface); }
    [ComVisible(true), Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivationHandler { void ActivateCompleted(IActivationOperation operation); }
    [ComVisible(true), Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAgileObject { }
    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public sealed class ActivationHandler : IActivationHandler, IAgileObject
    {
        internal readonly TaskCompletionSource<IAudioClient> Result = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public void ActivateCompleted(IActivationOperation operation)
        {
            try { operation.GetActivateResult(out var result, out var activated); Marshal.ThrowExceptionForHR(result); Result.TrySetResult((IAudioClient)activated); }
            catch (Exception error) { Result.TrySetException(error); }
        }
    }
}

