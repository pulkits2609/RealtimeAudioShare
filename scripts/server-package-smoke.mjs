// Verify a freshly built Windows server ZIP, without reading a deployed server's settings.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';

if (process.platform !== 'win32' || !process.argv[2]) throw new Error('Usage on Windows: node server-package-smoke.mjs <server.zip>');
const archive = await realpath(process.argv[2]);
const temp = await realpath(tmpdir());
const directory = await mkdtemp(path.join(temp, 'AudioShare server smoke '));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|COMSPEC|PATHEXT|NUMBER_OF_PROCESSORS)$/i.test(key)));
const reserved = new Set([9995, 9996, 9997, 9998, 9999]);
async function freePort(udp = false) {
  for (;;) {
    const socket = udp ? createSocket('udp4') : createServer();
    const ready = once(socket, 'listening');
    if (udp) socket.bind(0, '0.0.0.0'); else socket.listen(0, '0.0.0.0');
    await ready;
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    if (!reserved.has(port)) { reserved.add(port); return port; }
  }
}
function run(executable, args, cwd = directory) {
  const proc = spawnSync(executable, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (proc.error) throw proc.error;
  assert.equal(proc.status, 0, (proc.stderr || proc.stdout).slice(-800));
  return proc.stdout;
}
let server;
let exit;
async function launch(api, frontend, udp, tcp) {
  server = spawn(process.env.ComSpec, ['/d', '/c', 'run.bat', ...[api, frontend, udp, tcp].map(String)], {
    cwd: directory, env: { ...env, LIVEKIT_NODE_IP: '127.0.0.1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  exit = once(server, 'exit');
  let output = '';
  server.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-8192); });
  server.stderr.resume();
  const deadline = Date.now() + 45000;
  while (!output.includes(`AudioShare server ready on port ${api}`)) {
    assert.equal(server.exitCode, null, 'Bundled launcher exited before readiness');
    assert.ok(Date.now() < deadline, 'Bundled launcher timed out before readiness');
    await delay(100);
  }
  assert.ok(output.includes(`Browser frontend port: ${frontend}. Media: UDP ${udp}, TCP ${tcp}.`));
}
async function stop() {
  server.stdin.end();
  const [code] = await Promise.race([exit, delay(10000, undefined, { ref: false }).then(() => { throw new Error('Bundled launcher did not exit after stdin EOF'); })]);
  assert.equal(code, 0);
}
try {
  const extract = `import pathlib, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    entries = z.namelist()
    assert z.testzip() is None and 'run.bat' in entries
    assert all(not pathlib.PureWindowsPath(n).is_absolute() and not pathlib.PureWindowsPath(n).drive and '..' not in pathlib.PureWindowsPath(n).parts for n in entries)
    assert all(pathlib.PurePosixPath(n).name.lower() not in ['settings.env', '.env', 'access.json', 'livekit.yaml'] and not n.lower().startswith(('data/', 'app/data/')) for n in entries)
    z.extractall(sys.argv[2])
    print(len(entries))`;
  const entryCount = Number(run('python', ['-c', extract, archive, directory]).trim());
  const node = path.join(directory, 'runtime/node.exe');
  const native = run(node, ['--input-type=module', '-e', `
    import opus from '@discordjs/opus';
    import { Room, dispose } from '@livekit/rtc-node';
    const packet = new opus.OpusEncoder(48000, 2).encode(Buffer.alloc(3840));
    if (!packet.length || typeof Room !== 'function') throw new Error('Native audio modules unavailable');
    await dispose();
    console.log(JSON.stringify({ node: process.version, abi: process.versions.modules, opusBytes: packet.length }));
  `], path.join(directory, 'app')).trim();
  assert.match(run(process.env.ComSpec, ['/d', '/c', 'run.bat', '--help']), /MEDIA_UDP_PORT.*MEDIA_TCP_PORT/);
  const api = await freePort(), frontend = await freePort(), udp = await freePort(true), tcp = await freePort();
  // Only the bundled launcher and its children inherit this disposable cwd and stdin.
  await launch(api, frontend, udp, tcp);
  const base = `http://127.0.0.1:${api}`;
  const origin = 'http://tauri.localhost';
  const request = (resource, method = 'GET', body, auth, from = origin) => fetch(base + resource, {
    method, headers: { Origin: from, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000),
  });
  assert.equal((await request('/ready')).status, 200);
  for (const from of [origin, 'https://tauri.localhost', `http://localhost:${frontend}`]) {
    const cors = await request('/v1/session', 'OPTIONS', undefined, undefined, from);
    assert.equal(cors.status, 204);
    assert.equal(cors.headers.get('access-control-allow-origin'), from);
  }
  assert.equal((await request('/v1/session', 'OPTIONS', undefined, undefined, 'https://tauri.localhost.example')).status, 403);
  const { OWNER_TOKEN } = parseEnv(await readFile(path.join(directory, 'settings.env'), 'utf8'));
  assert.ok(OWNER_TOKEN, 'First launch did not create an owner credential');
  const ownerResponse = await request('/v1/auth/session', 'POST', { name: 'Server build test owner', token: OWNER_TOKEN });
  assert.equal(ownerResponse.status, 200);
  const owner = await ownerResponse.json();
  const room = 'portable-check';
  assert.equal((await request('/v1/rooms', 'POST', { name: room }, owner.accessToken)).status, 201);
  const inviteResponse = await request(`/v1/rooms/${room}/invites`, 'POST', { role: 'participant', maxUses: 1 }, owner.accessToken);
  assert.equal(inviteResponse.status, 201);
  const { token } = await inviteResponse.json();
  assert.ok(token, 'Invitation missing');
  const guest = await request('/v1/auth/session', 'POST', { name: 'Server build test guest', token });
  assert.equal(guest.status, 200);
  const replay = await request('/v1/auth/session', 'POST', { name: 'Rejected second redemption', token });
  assert.equal(replay.status, 401);
  await stop();
  const settingsPath = path.join(directory, 'settings.env');
  const initial = await readFile(settingsPath, 'utf8');
  const explicit = 'https://test-ui.example';
  const configured = initial.replace(/^ALLOWED_ORIGINS=.*$/m, `ALLOWED_ORIGINS=${explicit}`);
  assert.ok(configured !== initial, 'Expected an explicit allowlist field in generated test settings.');
  await writeFile(settingsPath, configured, { mode: 0o600 });
  await launch(api, frontend, udp, tcp);
  const overridden = await request('/v1/session', 'OPTIONS', undefined, undefined, explicit);
  assert.equal(overridden.status, 204);
  assert.equal(overridden.headers.get('access-control-allow-origin'), explicit);
  assert.equal((await request('/v1/session', 'OPTIONS')).status, 403);
  assert.ok(await readFile(settingsPath, 'utf8') === configured, 'The launcher overwrote explicit settings.');
  await stop();
  for (const port of [api, tcp]) {
    const probe = createServer();
    const ready = once(probe, 'listening'); probe.listen(port, '127.0.0.1'); await ready;
    await new Promise(resolve => probe.close(resolve));
  }
  const udpProbe = createSocket('udp4');
  const bound = once(udpProbe, 'listening'); udpProbe.bind(udp, '127.0.0.1'); await bound;
  await new Promise(resolve => udpProbe.close(resolve));
  console.log(JSON.stringify({ files: entryCount, native: JSON.parse(native), ready: true, exactOrigins: true, explicitOriginsPreserved: true, ownerInvite: true, singleUse: true, cleanShutdown: true }));
} finally {
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    server.stdin.end();
    await Promise.race([exit.catch(() => {}), delay(7000)]);
    if (server.exitCode === null && server.signalCode === null) {
      // Fallback is scoped to this still-live smoke launcher and its process tree.
      spawnSync('taskkill.exe', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      await exit.catch(() => {});
    }
  }
  const verified = await realpath(directory);
  assert.equal(path.dirname(verified), temp);
  assert.ok(path.basename(verified).startsWith('AudioShare server smoke '));
  await rm(verified, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
