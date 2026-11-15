# AudioShare · Tauri meeting client

React 19 + TypeScript + Vite, hosted by Tauri 2 on Windows, with the existing LiveKit protocol and Windows WASAPI capture engine. The previous application and server remain in `../electron/`. This client does not need an Electron runtime.

## Use the builds

Final ZIPs are generated under `artifacts/` after verification. Windows ZIPs contain the executable and its required `native/` helper; extract the whole directory before running. The browser ZIP is a static HTTPS deployment build, not an executable and not a new media server. Android contains the freshly built existing Kotlin client, debug-signed for installation testing.

The existing public contract is unchanged: `https://vps.pulkitworks.info:9999` for API/signaling, optional frontend on HTTPS port 9998, media UDP 9996 and TCP fallback 9997, and relative `/media`. Enter the host, API port and TLS preference in the connection form. An existing server must explicitly allow the packaged Windows origin `http://tauri.localhost`; see `MIGRATION.md`. No production credentials, allowlists or stored access data are changed automatically.

## Develop

Requirements: Node.js 22.12+, Rust/MSVC, Visual Studio C++ Build Tools and WebView2. Rebuilding the capture helper additionally needs the .NET 8 SDK. Recipients of the self-contained Windows build do not need .NET installed.

```powershell
cd rust
npm ci --legacy-peer-deps
npm run build:native
npm run desktop
```

If the .NET SDK is not on PATH, set `AUDIOSHARE_DOTNET` to its `dotnet.exe`, or pass `npm run build:native -- -DotnetPath C:\path\to\dotnet.exe`. The script never downloads an SDK automatically. Once the helper has been built, `npm run desktop` reuses it.

- `npm run dev`: browser frontend on loopback port 1420.
- `npm run build`: typecheck and browser production build in `dist/`.
- `npm run build:desktop`: optimized Windows executable and native helper in `src-tauri/target/release/`.
- `npm test`: media lifecycle, chat, PCM worklet, sound and desktop bridge regressions.
- `npm run test:e2e`: starts only its own isolated localhost test services and exchanges synthetic media between browsers. Requires the existing server build, local LiveKit executable and Playwright browser; set `PLAYWRIGHT_CHANNEL=chrome` to use installed Chrome.
- `npm run check:rust` / `cargo test --manifest-path src-tauri/Cargo.toml`: native checks and deterministic native tests.
- `npm run smoke:native`: tests the packaged debug window using an isolated WebView profile; first build it with `npm run tauri -- build --debug --no-bundle`. It enumerates devices, but never records audio or grants physical microphone/camera permission.
- `npm run storybook` / `npm run build-storybook`: component development and static verification on port 6006.

## Meeting controls

Joining opens one canvas with participant, screen and device-audio tiles. Use Auto/Grid/Focus layouts, multiple local pins and Return to gallery. The bottom toolbar keeps microphone, camera, screen, device audio, listening/deafen and Leave distinct. Chat and Participants open side drawers. Device selectors, requested sharing quality/FPS, listening routes, diagnostics, sound settings and authorized room management are in Settings. Narrow windows expose secondary controls through More.

Microphone and camera start OFF. Source controls stay cancellable during pending starts. Windows screen capture uses the actual WebView2/OS picker; no source is selected silently. Windows microphone permission is session-scoped and explicitly revocable. Browser capture and OS capabilities differ; unavailable features produce errors rather than fabricated success.

Shortcuts (outside text editing and IME composition): Ctrl+Shift+M microphone, Ctrl+Shift+V camera, Ctrl+Shift+D deafen, Ctrl+Shift+C chat. Escape closes drawers/dialogs or exits fullscreen. Chat uses Enter to send and Shift+Enter for a newline; retries reuse their message ID. Reliable data-channel publication is not persistent history or guaranteed delivery after disconnection.

Interface sounds have a master toggle, volume and event preferences. Original synthesized tones use a separate local audio context and are suppressed during outgoing media activity to avoid entering captures. They never represent measured audio activity. Media indicators use SDK status, PCM analysis and RTC statistics.

## Acceptance boundaries

See `VERIFICATION.md` for actual checks and `requirements/meeting-redesign.txt` for the approved brief. Physical Android/Windows devices, native picker/consent behavior, actual playback exclusion and public HTTPS/WSS/TCP fallback remain separate acceptance checks. Windows is unsigned and Android is debug-signed; these are acceptance builds, not Store submissions. Store packaging is gated on the brief's remaining hardware/network acceptance and release signing.
