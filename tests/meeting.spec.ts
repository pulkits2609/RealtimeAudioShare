import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { captureView, closeSettings, openSettings, startSharing } from './controls';

async function join(page: Page, name: string, room: string) {
  await page.goto('/');
  await page.getByLabel('Your name', { exact: true }).fill(name);
  await page.getByLabel('Server address', { exact: true }).fill('127.0.0.1');
  await page.getByLabel('Port', { exact: true }).fill('18787');
  await page.getByLabel('Room', { exact: true }).fill(room);
  await page.getByRole('button', { name: 'Join server', exact: true }).click();
  await expect(page.locator('.connection-state:visible')).toHaveText('Connected', { timeout: 25000 });
}

test('offline UI isolates connection settings and the fixture accepts only configured desktop origins', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your connection', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on microphone', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeHidden();
  await captureView(page, 'connection');
  for (const origin of ['http://tauri.localhost', 'https://tauri.localhost', 'http://127.0.0.1:1420']) {
    const response = await request.fetch('http://127.0.0.1:18787/v1/session', { method: 'OPTIONS', headers: { Origin: origin } });
    expect(response.status()).toBe(204);
    expect(response.headers()['access-control-allow-origin']).toBe(origin);
  }
  const rejected = await request.fetch('http://127.0.0.1:18787/v1/session', {
    method: 'OPTIONS', headers: { Origin: 'https://tauri.localhost.example' },
  });
  expect(rejected.status()).toBe(403);
});

test('three clients exchange chat, camera and simultaneous screens, preserving tile playback across layout changes', async ({ browser }) => {
  const sender = await browser.newPage({ permissions: ['microphone', 'camera', 'local-network-access'] });
  const listener = await browser.newPage({ permissions: ['microphone', 'camera', 'local-network-access'] });
  const observer = await browser.newPage({ permissions: ['microphone', 'local-network-access'] });
  // Give all five observer tiles a row, including both decoded screen feeds.
  await observer.setViewportSize({ width: 1560, height: 880 });
  try {
    // Supply a moving test pattern without screen selection or desktop capture.
    for (const page of [sender, listener]) await page.addInitScript(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640; canvas.height = 360;
        const drawing = canvas.getContext('2d')!;
        const draw = () => { drawing.fillStyle = `hsl(${Date.now() / 30 % 360},80%,50%)`; drawing.fillRect(0, 0, 640, 360); };
        draw();
        const timer = setInterval(draw, 40);
        const stream = canvas.captureStream(25);
        const track = stream.getVideoTracks()[0], stop = track.stop.bind(track);
        track.stop = () => { clearInterval(timer); stop(); };
        return stream;
      };
    });
    await join(sender, 'Tauri sender', 'desktop-port-video');
    await join(listener, 'Tauri listener', 'desktop-port-video');
    const peers = sender.getByTestId('peer');
    await expect(peers).toContainText('Tauri listener');
    await expect(listener.getByLabel('Your name', { exact: true })).toBeHidden();
    await expect(listener.locator('audio[data-source="microphone"]')).toHaveCount(0);
    for (const page of [sender, listener]) await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await sender.getByLabel('Message', { exact: true }).fill('Hello through the local SFU');
    await sender.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(listener.getByRole('log', { name: 'Room messages' })).toContainText('Hello through the local SFU');
    for (const page of [sender, listener]) await page.getByRole('button', { name: 'Close chat', exact: true }).click();

    const videoWidth = (id: string) => listener.getByTestId(id).locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth);
    await sender.getByRole('button', { name: 'Turn on camera', exact: true }).click();
    await expect.poll(() => videoWidth('remote-camera'), { timeout: 20000 }).toBeGreaterThan(0);
    await startSharing(sender, 'screen');
    await expect.poll(() => videoWidth('remote-video'), { timeout: 20000 }).toBeGreaterThan(0);
    const remoteScreen = listener.getByTestId('remote-video').locator('video');
    const originalVideo = await remoteScreen.elementHandle();
    if (!originalVideo) throw new Error('The decoded screen video must exist before changing the layout.');
    await listener.getByRole('button', { name: 'Pin Tauri sender · Screen', exact: true }).click();
    await expect(listener.getByRole('button', { name: 'Unpin Tauri sender · Screen', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await listener.getByRole('button', { name: 'Focus Tauri sender · Screen', exact: true }).click();
    await expect(listener.getByLabel('Meeting layout')).toHaveValue('focus');
    if (await listener.evaluate(() => document.fullscreenEnabled)) {
      await listener.getByRole('button', { name: 'Fullscreen tile Tauri sender · Screen', exact: true }).click();
      await expect.poll(() => listener.evaluate(() => document.fullscreenElement?.classList.contains('source-screen'))).toBe(true);
      await listener.keyboard.press('Escape');
      await expect.poll(() => listener.evaluate(() => document.fullscreenElement === null)).toBe(true);
      console.log('Verified fullscreen enter and Escape exit on the decoded screen tile.');
    }
    await captureView(listener, 'focused-screen');
    await listener.getByRole('button', { name: 'Chat', exact: true }).click();
    expect(await remoteScreen.evaluate((current, original) => current === original && (current as HTMLVideoElement).videoWidth > 0, originalVideo)).toBe(true);
    await captureView(listener, 'chat-drawer');
    await listener.getByRole('button', { name: 'Close chat', exact: true }).click();
    await listener.getByRole('button', { name: 'Return to gallery', exact: true }).click();
    await expect(listener.getByLabel('Meeting layout')).toHaveValue('grid');
    expect(await remoteScreen.evaluate((current, original) => current === original, originalVideo)).toBe(true);
    await captureView(listener, 'gallery');
    await listener.getByRole('switch', { name: 'Dark mode', exact: true }).click();
    await expect(listener.getByRole('switch', { name: 'Dark mode', exact: true })).toHaveAttribute('aria-checked', 'true');
    await captureView(listener, 'gallery-dark');
    await originalVideo.dispose();

    await openSettings(listener, 'Devices');
    await listener.getByLabel('Audio-only listening', { exact: true }).check();
    await expect(listener.getByTestId('remote-video')).toHaveCount(0);
    await listener.getByLabel('Audio-only listening', { exact: true }).uncheck();
    await closeSettings(listener);
    await expect.poll(() => videoWidth('remote-video'), { timeout: 20000 }).toBeGreaterThan(0);
    await join(observer, 'Observing participant', 'desktop-port-video');
    await startSharing(listener, 'screen');
    const stage = observer.getByRole('region', { name: 'Meeting view' });
    await expect(stage.getByTestId('remote-video')).toHaveCount(2);
    await stage.getByLabel('Meeting layout').selectOption('grid');
    for (const name of ['Tauri sender', 'Tauri listener']) {
      const tile = stage.locator('.source-screen').filter({ has: observer.getByRole('button', { name: `Pin ${name} · Screen`, exact: true }) });
      await expect.poll(() => tile.locator('video').evaluate((el: HTMLVideoElement) => el.videoWidth)).toBeGreaterThan(0);
      expect(await tile.evaluate(el => el.previousElementSibling?.querySelector('.source-tile-heading span')?.textContent)).toBe(`${name} · Camera`);
      await tile.getByRole('button', { name: `Pin ${name} · Screen`, exact: true }).click();
    }
    await expect(stage.locator('[data-pinned="true"]')).toHaveCount(2);
    await captureView(observer, 'two-screens-pinned');
    const retained = stage.locator('.source-screen').filter({ has: observer.getByRole('button', { name: 'Unpin Tauri sender · Screen', exact: true }) }).locator('video');
    const retainedNode = await retained.elementHandle();
    if (!retainedNode) throw new Error('Expected a decoded screen from the first publisher.');

    // CDP reports Chromium renderer task time, excluding codec, GPU, OS and SFU work.
    const sessions = await Promise.all([sender, listener, observer].map(page => page.context().newCDPSession(page)));
    try {
      await Promise.all(sessions.map(session => session.send('Performance.enable')));
      const sample = async () => Promise.all(sessions.map(async session => {
        const { metrics } = await session.send('Performance.getMetrics');
        return Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
      }));
      const before = await sample();
      await new Promise(resolve => setTimeout(resolve, 3000));
      const after = await sample();
      const measurements = after.map((end, i) => {
        const wallSeconds = end.Timestamp - before[i].Timestamp;
        const rendererTaskSeconds = end.TaskDuration - before[i].TaskDuration;
        return { client: ['publisher A', 'publisher B', 'observer'][i], wallSeconds, rendererTaskSeconds, rendererMainThreadBusyFraction: rendererTaskSeconds / wallSeconds };
      });
      const filename = test.info().outputPath('renderer-task-sample.json');
      await writeFile(filename, JSON.stringify({ scenario: 'Three local Chromium clients, two synthetic screen publishers, one synthetic camera', measurements }, null, 2));
      await test.info().attach('renderer-task-sample', { path: filename, contentType: 'application/json' });
    } finally {
      await Promise.all(sessions.map(session => session.detach()));
    }
    await listener.getByRole('button', { name: 'Stop sharing screen', exact: true }).click();
    await expect(stage.getByTestId('remote-video')).toHaveCount(1);
    await expect(stage.locator('[data-pinned="true"]')).toHaveCount(1);
    expect(await retained.evaluate((current, original) => current === original && (current as HTMLVideoElement).videoWidth > 0, retainedNode)).toBe(true);
    await retainedNode.dispose();
    await observer.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await sender.getByRole('button', { name: 'Stop sharing screen', exact: true }).click();
    await expect(listener.getByTestId('remote-video')).toHaveCount(0);
    await expect.poll(() => videoWidth('remote-camera')).toBeGreaterThan(0);
    await listener.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(listener.getByRole('button', { name: 'Join server', exact: true })).toBeVisible();
    await expect(peers).toHaveCount(0);
  } finally {
    await Promise.all([sender.close(), listener.close(), observer.close()]);
  }
});

test('narrow meeting keeps Leave on screen and restores keyboard focus after closing Settings', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 760 });
  await page.context().grantPermissions(['microphone', 'local-network-access']);
  await join(page, 'Compact participant', 'desktop-port-compact');
  const leave = page.getByRole('button', { name: 'Disconnect', exact: true });
  const rect = await leave.boundingBox();
  expect(rect).not.toBeNull();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(381);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(761);
  await captureView(page, 'narrow-380');
  const more = page.getByRole('button', { name: 'More', exact: true });
  await more.focus();
  await page.keyboard.press('Enter');
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  await settings.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(more).toBeFocused();
  await leave.click();
  await expect(page.getByRole('button', { name: 'Join server', exact: true })).toBeVisible();
});
