# AudioShare portable server · 15 November 2026

## Build and compatibility changes

The source server is `../electron/server`; portable packaging lives in `../electron/packaging/server`. The new ZIP is a self-contained **Windows x64 server**, including Node 24.22.1, LiveKit 1.13.10, production Node modules/native RTC and Opus bindings, and a freshly rebuilt static-runtime private C++ lobby component. No global Node/npm/compiler is needed to start it.

New generated origin defaults include the exact Tauri origins `http://tauri.localhost`, `https://tauri.localhost` and the development origin `http://127.0.0.1:1420`. Host entries are bounded so the total stays within the existing 32-origin validator limit. Exact-origin matching and authentication remain enforced. Existing explicit `ALLOWED_ORIGINS` is preserved rather than silently widened.

No deployed `.env`, `settings.env`, credentials or access data was read into the build or changed. The packaged ZIP contains none of those runtime files. First launch creates unique secrets and an access store for that extracted server. Keep the resulting `settings.env` and `data/` private; distribute the original clean ZIP, not a started folder.

The existing run contract is unchanged:

```bat
run.bat 9999 9998 9996 9997
```

Arguments are API port, frontend port, media UDP port and media TCP port. The launcher does not serve browser files; the new browser build is static content for your frontend server. The portable server uses HTTP/WS locally. Your existing trusted TLS reverse proxy provides public HTTPS/WSS, preserving API/signaling `https://vps.pulkitworks.info:9999`, optional frontend HTTPS 9998 and relative `/media` signaling.

For an existing server with an explicit allowlist, append the needed Tauri origin yourself while retaining current browser entries, credentials and access data. The previous Electron null-origin support remains available.

## Verification completed

- Fresh TypeScript server production build passed using bundled Node 24.22.1.
- **34 backend tests passed**, including configuration rejection, actual HTTP/WebSocket behavior, managed access, private C++ lobby/control, restart bounds and EOF cleanup.
- **5 launcher tests passed**. The new Tauri-default regression failed before the origin change and passed afterward, including the origin-count cap and rejection of a lookalike.
- Private C++ component rebuilt with static MSVC runtime. `dumpbin` lists only `WS2_32.dll` and `KERNEL32.dll` as its dependencies.
- Final standalone ZIP CRC test passed: **3,087 unique entries**, including 98 license/notice files. Archived launcher, README, server entry point and C++ binary match the final build inputs.
- The exact final ZIP was extracted into a fresh temporary directory whose path contains spaces. Its bundled Node reports **v24.22.1 / ABI 137**, imports the actual RTC and Opus native modules, and encodes a synthetic Opus frame.
- Extracted `run.bat` accepted four custom test ports, started the packaged service and media process, and returned readiness successfully.
- The packaged API accepted the exact Tauri and selected frontend origins and rejected a lookalike origin. An owner created a room and one-use invitation; first redemption succeeded and the second was rejected.
- A second launch preserved an explicitly configured settings file byte-for-byte and accepted only the manually configured origin.
- Closing the owned test launcher's stdin stopped its children and released API/media TCP and UDP ports on both launches. Normal services on ports 9998/9999 were not started, stopped or reused by these tests.
- Archive inspection rejected runtime settings, `.env` files, access stores, data directories, logs, keys and other listed sensitive file types before packaging.

Standalone ZIP: `AudioShare-Server-2026-11-15.zip`  
Size: 83,716,135 bytes  
SHA-256: `d3dfbb38064482b0e5ce1dd61a43661487fb759027274ccb2272bf9c099b71c0`

The updated combined ZIP includes all three previously delivered client builds plus this server. The original client ZIP files remain unchanged. `SHA256SUMS.txt` and `manifest-with-server.json` cover the current artifacts.

## Boundaries

This build was tested locally on Windows. It does not install certificates, change DNS/router/firewall settings, deploy the VPS, prove public HTTPS/WSS/TURN reachability, or prove Internet TCP fallback with UDP blocked. Those deployment checks remain separate. The Windows server package is not a Linux binary; the existing source Docker/Linux deployment instructions remain available in the server project.

Client physical-device and signing/Store acceptance boundaries remain documented in `VERIFICATION.md`. The existing API, owner/invitation authentication, room tokens, Android companion identities, separate source tracks and reliable chat contract are preserved.
