using System.Buffers.Binary;
using System.Text.Json;

internal static class FramedOutput
{
    private static readonly Stream Stream = Console.OpenStandardOutput();
    public static void Control(object message) => Write(2, JsonSerializer.SerializeToUtf8Bytes(message), 0, 0);
    public static void Audio(byte[] samples, int sampleRate, int channels) => Write(1, samples, sampleRate, channels);
    private static void Write(uint kind, byte[] payload, int sampleRate, int channels)
    {
        Span<byte> header = stackalloc byte[20];
        "ASB1"u8.CopyTo(header);
        BinaryPrimitives.WriteUInt32LittleEndian(header[4..], kind);
        BinaryPrimitives.WriteUInt32LittleEndian(header[8..], (uint)payload.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(header[12..], (uint)sampleRate);
        BinaryPrimitives.WriteUInt32LittleEndian(header[16..], (uint)channels);
        // BoundedOutput serializes all control and audio writes on one worker.
        Stream.Write(header);
        Stream.Write(payload);
        Stream.Flush();
    }
}
