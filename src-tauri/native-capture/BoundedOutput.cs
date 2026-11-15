using System.Collections.Concurrent;

// Audio callbacks only copy and enqueue. Pipe writes and serialization run on this worker.
internal sealed class BoundedOutput : IDisposable
{
    private readonly BlockingCollection<Action> controls = new(32);
    private readonly Queue<Action> audio = new();
    private readonly object audioLock = new();
    private readonly AutoResetEvent ready = new(false);
    private readonly Thread worker;
    private volatile bool completed;
    internal const int AudioCapacity = 4;

    public BoundedOutput()
    {
        worker = new Thread(Run) { IsBackground = true, Name = "AudioShare output writer" };
        worker.Start();
    }

    public void Control(Action write) { controls.Add(write); ready.Set(); }
    public void Audio(Action write)
    {
        lock (audioLock)
        {
            if (completed) return;
            if (audio.Count == AudioCapacity) audio.Dequeue();
            audio.Enqueue(write);
        }
        ready.Set();
    }

    private void Run()
    {
        while (true)
        {
            if (controls.TryTake(out var control)) { control(); continue; }
            Action? next;
            lock (audioLock) next = audio.Count > 0 ? audio.Dequeue() : null;
            if (next != null) { next(); continue; }
            if (completed && controls.Count == 0) return;
            ready.WaitOne();
        }
    }

    public void Dispose()
    {
        controls.CompleteAdding();
        completed = true;
        ready.Set();
        // A dead parent can leave stdout blocked. The worker is background-only;
        // closing stdin must still let the helper process exit promptly.
        if (worker.Join(1000)) { ready.Dispose(); controls.Dispose(); }
    }
}
