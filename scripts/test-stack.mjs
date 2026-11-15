import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { access, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const electron = path.resolve(root, '../electron');
const host = '127.0.0.1';
const ports = { web: 15173, api: 18787, media: 19995 };
// Separate loopback UDP sockets carry ICE checks on Windows; a single muxed port
// can advertise a reachable candidate yet never answer Chrome's connectivity checks.
const rtcFirst = 19996, rtcLast = 20020;
const desktopOrigins = ['http://tauri.localhost', 'https://tauri.localhost', 'http://127.0.0.1:1420'];

async function assertAvailable(port, udp = false) {
  const probe = udp ? createSocket('udp4') : createServer();
  try {
    const ready = once(probe, 'listening');
    if (udp) probe.bind(port, host);
    else probe.listen(port, host);
    await ready;
  } catch (error) {
    throw new Error(`Fixture needs free ${udp ? 'UDP' : 'TCP'} port ${port} on ${host}: ${error.message}`);
  }
  await new Promise(resolve => probe.close(resolve));
}

export default async function startTestStack() {
  const mediaExe = process.env.LIVEKIT_EXECUTABLE || path.join(electron, 'work/tools/livekit', process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server');
  const server = path.join(electron, 'server/dist/index.js');
  const vite = path.join(root, 'node_modules/vite/bin/vite.js');
  await Promise.all([mediaExe, server, vite, path.join(root, 'dist/index.html')].map(file => access(file)));
  for (const port of Object.values(ports)) await assertAvailable(port);
  for (let port = rtcFirst; port <= rtcLast; port++) await assertAvailable(port, true);

  const work = await mkdtemp(path.join(tmpdir(), 'audioshare-tauri-e2e-'));
  const yaml = path.join(work, 'livekit.yaml');
  const key = 'isolated_fixture';
  const secret = randomBytes(32).toString('hex');
  const children = [];
  function stopChildren() {
    for (const child of [...children].reverse()) {
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
    }
  }
  async function teardown() {
    const exits = children.filter(child => child.pid && child.exitCode === null && child.signalCode === null).map(child => once(child, 'exit'));
    stopChildren();
    await Promise.allSettled(exits);
    process.off('exit', stopChildren);
    delete process.env.AUDIOSHARE_TEST_SFU_SECRET;
    await rm(yaml, { force: true });
    await rmdir(work);
  }
  process.once('exit', stopChildren);
  // Do not inherit service tokens, NODE_OPTIONS, or machine deployment settings.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|COMSPEC|PATHEXT)$/i.test(name)));
  async function start(executable, args, cwd, port, extra = {}) {
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: 'inherit', env: { ...env, ...extra } });
    children.push(child);
    await once(child, 'spawn');
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (children.some(p => p.exitCode !== null || p.signalCode !== null)) throw new Error('An isolated fixture process exited before readiness.');
      const response = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
      if (response) { await response.body?.cancel(); return; }
      await delay(150);
    }
    throw new Error(`Fixture port ${port} did not become ready.`);
  }

  try {
    await writeFile(yaml, `port: ${ports.media}
bind_addresses: [127.0.0.1]
rtc:
  # LiveKit 1.13 binds its RTC TCP listener to all interfaces. Keep media on loopback UDP.
  tcp_port: 0
  port_range_start: ${rtcFirst}
  port_range_end: ${rtcLast}
  ips:
    includes: ["127.0.0.0/8"]
  node_ip: 127.0.0.1
  enable_loopback_candidate: true
  advertise_internal_ip: true
  use_external_ip: false
  use_mdns: true
  # Keep discovery local. Peers connect via the SFU's host candidates.
  stun_servers: ["127.0.0.1:${rtcFirst}"]
keys:
  ${key}: "${secret}"
logging:
  level: warn
`, { mode: 0o600 });
    await start(mediaExe, ['--config', yaml], work, ports.media);
    // index.js loads .env from cwd. This directory contains only our generated LiveKit config.
    await start(process.execPath, [server], work, ports.api, {
      HOST: host, PORT: String(ports.api), LIVEKIT_URL: `http://${host}:${ports.media}`,
      LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret, ALLOW_GUESTS: 'true',
      ALLOWED_ORIGINS: [`http://localhost:${ports.web}`, `http://${host}:${ports.web}`, ...desktopOrigins].join(','),
      SESSION_RATE_LIMIT: '500', ENABLE_LEGACY_BRIDGE: 'false',
    });
    await start(process.execPath, [vite, 'preview', '--host', host, '--port', String(ports.web), '--strictPort'], root, ports.web);
    // Playwright workers start after global setup. A managed-room test creates its
    // own ephemeral API and access store against this same private SFU.
    process.env.AUDIOSHARE_TEST_SFU_SECRET = secret;
    return teardown;
  } catch (error) {
    await teardown();
    throw error;
  }
}
