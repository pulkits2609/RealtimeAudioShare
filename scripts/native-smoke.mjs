import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'verification');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, 'native-profile-'));
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const executable = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'src-tauri/target/debug/audioshare-desktop.exe');
const child = spawn(executable, [], { windowsHide: true, stdio: 'ignore', env: {
  ...process.env,
  WEBVIEW2_USER_DATA_FOLDER: profile,
  // Test process only. These flags are not configured or bundled in the app.
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --mute-audio --use-fake-device-for-media-stream`,
} });
await once(child, 'spawn');
let browser;
try {
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Native app exited (${child.exitCode}) before its window was ready.`);
    try { ready = (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })).ok; } catch { /* WebView startup. */ }
    if (ready) break;
    await delay(150);
  }
  assert(ready, 'WebView2 did not expose the isolated test debugger');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  let page;
  for (let tries = 0; tries < 50; tries++) {
    page = context.pages().find(candidate => candidate.url().startsWith('http://tauri.localhost'));
    if (page) break;
    await delay(100);
  }
  assert(page, 'Native local application document was not found');
  await page.getByRole('heading', { name: 'Your connection', exact: true }).waitFor();
  await page.waitForFunction(() => Boolean(window.audioShareDesktop));
  const result = await page.evaluate(async () => {
    const bridge = window.audioShareDesktop;
    const devices = await bridge.listOutputDevices();
    const capabilities = await bridge.getCaptureCapabilities();
    let invalidRejected = false;
    try { await bridge.startCapture('', 'endpoint'); } catch { invalidRejected = true; }
    await bridge.stopCapture();
    return {
      nativeBridge: Boolean(bridge),
      secureContext: window.isSecureContext,
      screenPickerApi: typeof navigator.mediaDevices?.getDisplayMedia === 'function',
      microphoneApi: typeof navigator.mediaDevices?.getUserMedia === 'function',
      outputCount: devices.devices.length,
      processExclusionSupportedByOS: capabilities.processExclusion,
      invalidRejected,
      stats: await bridge.getCaptureStats(),
      microphoneTracks: document.querySelectorAll('audio[data-source="microphone"]').length,
    };
  });
  assert(result.nativeBridge && result.secureContext && result.screenPickerApi && result.microphoneApi);
  assert(result.invalidRejected && result.stats.capacity === 4 && result.stats.pending === 0 && result.microphoneTracks === 0);
  const permissionProbe = await page.evaluate(async () => {
    let microphoneDenied = false;
    try {
      const microphone = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      microphone.getTracks().forEach(track => track.stop());
    } catch (error) { microphoneDenied = error.name === 'NotAllowedError'; }
    return { microphoneDenied };
  });
  assert(permissionProbe.microphoneDenied, 'Unapproved native microphone request was not denied');
  await page.screenshot({ path: path.join(output, 'native-connection.png'), fullPage: true });
  await writeFile(path.join(output, 'native-smoke.json'), JSON.stringify({ executable: path.basename(executable), ...result, ...permissionProbe, note: 'Enumerated actual output devices and rejected an unauthorized microphone request with synthetic device flags. Fake permission UI flags are deliberately absent: they bypass normal permission policy and cannot test it. No physical microphone/camera media recorded. Screen API presence does not prove OS picker operation.' }, null, 2));
  console.log('PASS: packaged page/bridge, device enumeration, capabilities, invalid-capture rejection, bounded queue and unapproved microphone denial.');
  // Revoke subscribers and stop the helper before terminating this owned test process.
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('capture_close'));
} finally {
  await browser?.close().catch(() => {});
  if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
}
