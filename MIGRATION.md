# Electron to Tauri migration

The new desktop client lives entirely in `rust/`. The original application remains in `../electron/` as a reference and as the existing server/deployment project.

## Architecture

- `src/meeting/`: the existing React UI, LiveKit room controller, capture lifecycle, quality policy, chat and managed-room client. Preserve these protocols rather than replacing proven media behavior during the shell migration.
- `src/desktop.ts`: installs the native bridge only in Tauri. Browser previews use browser media APIs and never pretend a native device is available.
- `src-tauri/`: native commands, permissions and WASAPI helper supervision. Binary PCM delivery is bounded; stalled rendering must drop stale audio instead of accumulating latency.
- `src-tauri/native-capture/`: source of the existing C# Windows audio engine. The host is Rust; this tested Windows capture engine is intentionally retained. This is not a claim that all source code was rewritten in Rust.
- The deployed session/token service and LiveKit remain external infrastructure. The desktop client connects to their existing protocol. No new cloud service, account system, telemetry or recording is introduced.

## Scope

Port connection and cancellation, WebRTC voice, camera and screen sharing, native output audio, chat, participants, separate listening routes/volumes, device recovery, quality controls, diagnostics, theme, managed rooms and invitation management. Add honest loading/recovery feedback, measured call duration and optional notification sounds. Suppress notification sounds when they could be included in a shared-audio route.

This scope does not assert parity with every feature of Discord or an unspecified optimization target. New messaging persistence, recording, accounts, billing, moderation services and end-to-end media encryption need concrete requirements and corresponding server support.

## Server origin configuration

Keep your existing server allowlist and append the origins required by this client:

```dotenv
# Append these exact origins to ALLOWED_ORIGINS; retain your existing entries.
# Windows packaged Tauri default origin:
# http://tauri.localhost
# Tauri development:
# http://127.0.0.1:1420
```

Only add `https://tauri.localhost` if the desktop is deliberately configured to use the HTTPS scheme. Do not use an unrestricted wildcard or bypass authentication to work around CORS. No production `.env` is modified by this port. TLS/WSS remains recommended for remotely deployed servers.

## Verification boundaries

`npm test` runs inherited media regression tests against the copied core. `npm run test:e2e` starts a dedicated localhost fixture with synthetic media and reserved test ports; it must never reuse normal services on 9998/9999. Browser networking and media tests do not prove Windows WASAPI, OS consent or screen-picker operation. Rust checks, native parser/queue tests and an actual packaged-window smoke are separate evidence. See `VERIFICATION.md` for the checks actually run and unresolved limitations.
