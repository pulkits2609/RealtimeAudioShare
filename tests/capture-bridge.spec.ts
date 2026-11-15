import { writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { captureView, closeSettings, openSettings, startSharing } from './controls';

test('synthetic desktop PCM reaches the listener in stereo through the worklet and real SFU', async ({ browser }) => {
  const source = await browser.newContext(), receiver = await browser.newContext();
  try {
    await source.grantPermissions(['microphone', 'camera', 'local-network-access']); await receiver.grantPermissions(['microphone', 'local-network-access']);
    await source.addInitScript(() => {
      let listener: ((data: { samples: Uint8Array; channels: number; sampleRate: number }) => void) | undefined;
      let timer: ReturnType<typeof setInterval> | undefined, offset = 0;
      window.audioShareDesktop = {
        platform: 'win32', listOutputDevices: async () => ({ devices: [{ id: 'deterministic-output', name: 'Test PCM endpoint' }], defaultDeviceId: 'deterministic-output' }),
        startCapture: async () => {
          timer = setInterval(() => {
            const pcm = new Float32Array(1920);
            for (let i = 0; i < 960; i++) {
              const noise = ((((offset + i + 1) * 1103515245) >>> 0) / 0xffffffff - 0.5) * 0.02;
              pcm[i * 2] = 0.25 * Math.sin((offset + i) * Math.PI * 2 * 440 / 48000) + noise;
              pcm[i * 2 + 1] = 0.25 * Math.sin((offset + i) * Math.PI * 2 * 880 / 48000) - noise;
            }
            offset += 960;
            const bytes = new Uint8Array(pcm.buffer);
            listener?.({ samples: bytes, channels: 2, sampleRate: 48000 });
          }, 20);
          return { sampleRate: 48000, channels: 2 };
        }, stopCapture: async () => { clearInterval(timer); },
        onAudio: callback => { listener = callback; return () => { if (listener === callback) listener = undefined; }; }, onCaptureError: () => () => {},
      };
    });
    const sender = await source.newPage(), listener = await receiver.newPage();
    for (const [page, name] of [[sender, 'PCM publisher'], [listener, 'PCM listener']] as const) {
      await page.goto('/'); await page.getByLabel('Your name', { exact: true }).fill(name);
      await page.getByLabel('Server address', { exact: true }).fill('127.0.0.1'); await page.getByLabel('Port', { exact: true }).fill('18787'); await page.getByLabel('Room', { exact: true }).fill('media-capture-controls');
      await page.getByRole('button', { name: 'Join server', exact: true }).click();
      await expect(page.locator('.connection-state:visible')).toHaveText('Connected', { timeout: 25000 });
    }
    await startSharing(sender, 'audio');
    let measured = { rms: 0, leftDb: 0, rightDb: 0 };
    const measure = () => listener.evaluate(async () => {
      const audio = document.querySelector<HTMLAudioElement>('audio[data-source="screen_share_audio"]'); if (audio?.muted || audio?.paused || !(audio?.srcObject instanceof MediaStream)) return { rms: 0, leftDb: 0, rightDb: 0 };
      const context = new AudioContext(); await context.resume();
      const node = context.createAnalyser(), right = context.createAnalyser(); node.fftSize = right.fftSize = 4096;
      const split = context.createChannelSplitter(2); context.createMediaStreamSource(audio.srcObject).connect(split); split.connect(node, 0); split.connect(right, 1);
      let rms = 0; const samples = new Float32Array(node.fftSize);
      for (let i = 0; i < 12; i++) { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); node.getFloatTimeDomainData(samples); rms = Math.max(rms, Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length)); }
      const l = new Float32Array(node.frequencyBinCount), r = new Float32Array(right.frequencyBinCount); node.getFloatFrequencyData(l); right.getFloatFrequencyData(r);
      const low = Math.round(440 * node.fftSize / context.sampleRate), high = Math.round(880 * node.fftSize / context.sampleRate);
      const result = { rms, leftDb: l[low] - r[low], rightDb: r[high] - l[high] };
      await context.close(); return result;
    });
    for (const quality of ['studio', 'music', 'adaptive']) {
      const dialog = await openSettings(sender, 'Device audio');
      await dialog.getByLabel('Audio quality', { exact: true }).selectOption(quality);
      await expect(sender.getByLabel('Audio quality', { exact: true })).toHaveValue(quality);
      await closeSettings(sender);
      await expect.poll(async () => { measured = await measure(); return measured.rms; }, { timeout: 15000 }).toBeGreaterThan(0.05);
      expect(measured.leftDb).toBeGreaterThan(8); expect(measured.rightDb).toBeGreaterThan(8);
    }
    const matrix: unknown[] = [];
    async function snapshot(mode: string, music: boolean) {
      if (music) await expect.poll(async () => { measured = await measure(); return measured.rms; }, { timeout: 15000 }).toBeGreaterThan(0.05);
      await Promise.all([openSettings(listener, 'Diagnostics'), openSettings(sender, 'Diagnostics')]);
      const expectedSources = mode === 'music-only' ? ['screen_share_audio'] : mode === 'mic-only' ? ['microphone'] : ['screen_share_audio', 'microphone'];
      for (const source of expectedSources) {
        await expect.poll(() => listener.locator(`[data-testid="audio-source-diagnostic"][data-direction="receive"][data-source="${source}"]`).getAttribute('data-bytes').then(Number)).toBeGreaterThan(500);
        await expect.poll(() => sender.locator(`[data-testid="audio-source-diagnostic"][data-direction="send"][data-source="${source}"]`).count()).toBe(1);
      }
      const before = await listener.getByTestId('audio-source-diagnostic').evaluateAll(elements => elements.map(e => ({ ...((e as HTMLElement).dataset) })));
      const beforeSending = await sender.getByTestId('audio-source-diagnostic').evaluateAll(elements => elements.map(e => ({ ...((e as HTMLElement).dataset) })));
      await expect.poll(() => listener.getByTestId('audio-source-diagnostic').evaluateAll(elements => elements.map(e => (e as HTMLElement).dataset.timestamp).join(','))).not.toBe(before.map(a => a.timestamp).join(','));
      const after = await listener.getByTestId('audio-source-diagnostic').evaluateAll(elements => elements.map(e => ({ ...((e as HTMLElement).dataset) })));
      const afterSending = await sender.getByTestId('audio-source-diagnostic').evaluateAll(elements => elements.map(e => ({ ...((e as HTMLElement).dataset) })));
      const rates = (start: typeof before, finish: typeof before) => finish.map(a => { const previous = start.find(b => a.source === b.source && a.direction === b.direction); const ms = Number(a.timestamp) - Number(previous?.timestamp); return { source: a.source, kbps: ms > 0 ? (Number(a.bytes) - Number(previous?.bytes)) * 8 / ms : null }; });
      matrix.push({ mode, music: music ? measured : undefined, receiveRates: rates(before, after), sendRates: rates(beforeSending, afterSending),
        sending: await sender.getByTestId('audio-source-diagnostic').evaluateAll(elements => elements.map(e => ({ ...((e as HTMLElement).dataset) }))),
        received: await listener.getByTestId('audio-source-diagnostic').evaluateAll(elements => elements.map(e => ({ ...((e as HTMLElement).dataset) }))),
        playback: await listener.locator('audio').evaluateAll(elements => elements.map(element => { const e = element as HTMLAudioElement; return { source: e.dataset.source, muted: e.muted, paused: e.paused, volume: e.volume, sink: e.sinkId }; })),
      });
      await Promise.all([closeSettings(listener), closeSettings(sender)]);
    }
    await snapshot('music-only', true);
    await sender.getByRole('button', { name: 'Stop sharing audio', exact: true }).click();
    await sender.getByRole('button', { name: 'Turn on microphone', exact: true }).click();
    await expect(sender.getByRole('button', { name: 'Turn off microphone', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(listener.locator('audio[data-source="microphone"]')).toHaveCount(1);
    await expect.poll(() => listener.locator('audio[data-source="microphone"]').evaluate(e => !(e as HTMLAudioElement).muted && !(e as HTMLAudioElement).paused)).toBe(true);
    await snapshot('mic-only', false);
    await startSharing(sender, 'audio');
    await snapshot('music-and-mic', true);
    await sender.evaluate(() => { navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const context = canvas.getContext('2d')!; const timer = setInterval(() => { context.fillStyle = `hsl(${Date.now() % 360},70%,50%)`; context.fillRect(0, 0, 640, 360); }, 30);
      const stream = canvas.captureStream(30), video = stream.getVideoTracks()[0];
      const stop = video.stop.bind(video); video.stop = () => { clearInterval(timer); stop(); }; return stream;
    }; });
    await startSharing(sender, 'screen');
    const width = (id: string) => listener.getByTestId(id).locator('video').evaluate((video: HTMLVideoElement) => video.videoWidth);
    await expect.poll(() => width('remote-video')).toBeGreaterThan(0);
    await sender.getByRole('button', { name: 'Turn on camera', exact: true }).click();
    await expect.poll(() => width('remote-camera')).toBeGreaterThan(0);
    await snapshot('device-audio-microphone-camera-and-screen', true);
    await listener.getByLabel('Meeting layout').selectOption('grid');
    await expect(listener.getByTestId('device-audio-tile')).toBeVisible();
    await expect(listener.getByTestId('device-audio-tile')).toContainText('Audio activity');
    await captureView(listener, 'multisource-gallery');
    const matrixPath = test.info().outputPath('audio-quality-matrix.json');
    await writeFile(matrixPath, JSON.stringify(matrix, null, 2));
    await test.info().attach('audio-quality-matrix', { path: matrixPath, contentType: 'application/json' });
    await sender.getByRole('button', { name: 'Turn off camera', exact: true }).click();
    await expect(listener.getByTestId('remote-camera')).toHaveCount(0);
    await expect.poll(() => width('remote-video')).toBeGreaterThan(0);
    await expect.poll(async () => (await measure()).rms).toBeGreaterThan(0.05);
    await sender.getByRole('button', { name: 'Turn on camera', exact: true }).click();
    await expect.poll(() => width('remote-camera')).toBeGreaterThan(0);
    await sender.getByRole('button', { name: 'Stop sharing audio', exact: true }).click();
    await expect(listener.getByTestId('device-audio-tile')).toHaveCount(0);
    await expect.poll(() => width('remote-camera')).toBeGreaterThan(0);
    await expect.poll(() => width('remote-video')).toBeGreaterThan(0);
    await expect(sender.getByRole('button', { name: 'Turn off microphone', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await startSharing(sender, 'audio');
    await sender.getByRole('button', { name: 'Stop sharing screen', exact: true }).click();
    await expect(listener.getByTestId('remote-video')).toHaveCount(0);
    await expect.poll(() => width('remote-camera')).toBeGreaterThan(0);
    await expect.poll(async () => (await measure()).rms).toBeGreaterThan(0.05);
    await expect(sender.getByRole('button', { name: 'Turn off microphone', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await sender.getByRole('button', { name: 'Turn off microphone', exact: true }).click();
    await expect.poll(async () => (await measure()).rms).toBeGreaterThan(0.05);
    await sender.getByRole('button', { name: 'Stop sharing audio', exact: true }).click();
    await expect(sender.getByRole('button', { name: 'Share device audio', exact: true })).toBeEnabled();
  } finally { await source.close(); await receiver.close(); }
});
