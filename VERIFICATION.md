# AudioShare build verification · 15 November 2026

These are acceptance builds. The Windows and browser meeting client has been ported and redesigned; Android is a fresh build of the existing interoperable Kotlin client. No Store submission, production deployment or physical-device acceptance is implied.

## Delivered changes

- Replaced the Electron desktop shell with a Rust/Tauri host and local-only command capability. The Windows helper is rebuilt from its copied C# source, self-contained and bundled; no Electron or installed .NET runtime is required by recipients.
- Preserved LiveKit/WebRTC, separate microphone/device-audio/camera/screen tracks, chat, managed rooms/invitations, device recovery, listening routes, volumes, quality settings, diagnostics and Android companion ownership.
- Replaced ordinary workspace tabs with a persistent meeting canvas, toolbar and settings/chat/participant drawers. Added local multiple pins, Auto/Grid/Focus layouts, source tiles and independent source controls. Drawer/layout changes preserve live video elements.
- Added accurate pending/recovery/unavailable states, cancellation, measured connected duration, deafen, documented keyboard shortcuts, configurable original sound cues and sound suppression during outgoing capture.
- Camera selection uses exact fixed-device constraints and generation fencing. Chat retries preserve message IDs and timestamps, avoid duplicate successful local echoes and preserve the draft. The reliable data channel does not provide durable offline history.
- Preserved deployment ports, relative `/media`, authentication and exact-origin CORS. Public HTTPS frontend port 9998 defaults to API port 9999 while gateway ports and saved preferences remain usable. No production configuration, credentials or access store was rewritten.

## Checks actually completed

| Check | Result |
|---|---|
| Frontend typecheck and Vite production build | Passed; latest assets are in `dist/` |
| Frontend regressions | **57 passed**, 10 files |
| Storybook production build | Passed |
| Rust formatting and `cargo check` | Passed |
| Rust deterministic tests | **10 passed**; 1 device/helper integration ignored in the default run |
| Explicit source-built helper integration | Passed actual endpoint/capability enumeration, shutdown and restart; no audio recorded |
| Independent native code review | Two permission issues found, fixed and regression-tested; re-review approved |
| Windows optimized Tauri build | Passed |
| Windows portable folder with spaces | Passed startup and native bridge from renamed `AudioShare.exe` plus adjacent `native/` helper |
| Packaged WebView native smoke | Actual output enumeration, supported capability reporting, invalid capture rejection, queue capacity 4, empty pending queue, microphone initially OFF and unauthorized microphone denial passed |
| Browser acceptance | **5 passed**, 51 seconds, using an isolated loopback API/SFU and synthetic media |
| Android build | Fresh `assembleDebug` succeeded |
| Android regression tests | **50 passed** |
| Android lint | 0 errors, 47 existing warnings |
| Android APK verification | v2 signature verified, one signer; debug-signed APK version 0.2.2, minimum Android API 29 |

The native microphone-denial check deliberately omits the Chromium fake permission-UI flag, because auto-grant flags bypass the permission path being tested. It uses an isolated profile and a synthetic test device; it never records physical microphone/camera media.

The final archives are generated only after required outputs exist. The packaging script checks every ZIP's CRC integrity and writes a SHA-256 manifest/checksum file. Windows is unsigned (`NotSigned`), and Android is debug-signed for installation testing.

## Browser acceptance scenarios

1. Disconnected connection screen, hidden meeting controls, accepted exact Tauri/dev origins and rejected lookalike origin.
2. Synthetic stereo PCM through the actual AudioWorklet and local LiveKit SFU across Adaptive/Music/Studio settings; concurrent camera, microphone, screen and device audio; independent source OFF/ON; actual RTC activity/rate measurements.
3. Managed owner login, creation and redemption of a one-use invitation, rejected second redemption, usage history and removal/disconnection of the guest, using an ephemeral store and test-only credential.
4. Three Chromium clients with two simultaneous screen publishers, camera playback, chat, pin/focus/gallery, multiple pins and clean pin removal; the surviving decoded video DOM element remains identical through drawer/layout changes and another source stopping. Actual HTML fullscreen entry and Escape exit passed.
5. A 380px meeting window keeps Leave in bounds; More and Settings work by keyboard, Escape dismisses the dialog and restores focus. Additional direct Playwright MCP checks at 1280×720 showed Join visible, no horizontal overflow and no console errors. Light/dark, chat, focused, multi-source and narrow screenshots are included in the combined ZIP.

During all-four-source overlap, synthetic received music RMS was 0.1061 and channel separation was 26.34 dB / 26.23 dB. These are test-fixture signal checks, not claims about physical hardware, fidelity or end-to-end latency.

A bounded three-client sample over 3.006 seconds measured Chromium renderer main-thread task fractions of 1.81%, 1.83% and 1.20%. It excludes codec threads, GPU, native capture and SFU work. It is not total CPU usage, a hardware benchmark or evidence that the port outperforms Electron.

Test services use loopback-only addresses and dedicated ports; they do not start, stop or reuse normal services on 9998/9999. This Windows LiveKit fixture uses a preflight-checked local RTP UDP range because the binary's single-port loopback mode did not complete ICE. This does not alter the deployed UDP 9996/TCP 9997 contract.

## Integrations that materially helped

- **Context7:** Tauri 2 command/channel/binary-response guidance and Motion 12 layout guidance; installed runtime versions were preserved.
- **shadcn:** discovered suitable primitives and inspected dependency metadata. Its server did not see the custom Magic UI/React Bits registries from this project path, and some requests timed out. No unavailable registry installation is claimed. Radix/shadcn-style tooltips and dialogs use the existing design tokens.
- **Motion:** restrained reduced-motion-aware drawer/layout transitions. No paid assets or effects were used.
- **Storybook:** component/state discovery, story guidance, isolated connection/loading/error examples, tooltip/dialog keyboard checks and preview/build verification.
- **Playwright:** actual rendered browser checks and screenshots; automated isolated WebRTC acceptance; separate CDP inspection of the actual packaged WebView2 app.

Codebase-memory was unavailable, so relevant source and configurations were inspected directly. Figma had no supplied frame; no design file was invented. No Supabase, Sentry telemetry, OpenAI feature, external cloud backend or paid animation asset was introduced.

## Remaining acceptance gates

- Physical Windows microphone/camera consent and selection, actual native screen picker behavior, simultaneous real capture/playback, process-exclusion feedback test, real device unplug/replug, minimized/background playback, and OS/OEM differences.
- Physical Android projection/permissions, background service behavior, hotplug/Bluetooth, and real Android-to-Windows/browser media interoperability. Source/protocol compatibility is preserved, but physical-device testing has not run.
- Public deployment HTTPS/WSS, Internet NAT/firewall behavior, and repeating the live call with UDP blocked to prove TCP fallback. Local browser tests used HTTP/WS and loopback UDP, not the public VPS.
- End-to-end latency, total media CPU/GPU/memory benchmarking and larger participant counts.
- Windows signing/Store identity/package acceptance and Android release signing/Play requirements. Store update packaging remains gated on these checks and the brief's hardware/network acceptance; no Store-ready package is claimed.

## Server setup for the new Windows origin

The external API must append `http://tauri.localhost` to its existing exact `ALLOWED_ORIGINS`. Development additionally uses `http://127.0.0.1:1420`. Retain existing browser and Electron null-origin entries. Only add the HTTPS Tauri origin if that scheme is deliberately configured. No wildcard CORS or authentication bypass was added.

## Component previews

While the development Storybook is running:

- [Connection](http://localhost:6006/?path=/story/audioshare-connection--connection)
- [Validation](http://localhost:6006/?path=/story/audioshare-connection--validation-error)
- [Connecting](http://localhost:6006/?path=/story/audioshare-connection--connecting)
- [Disconnected meeting](http://localhost:6006/?path=/story/audioshare-meeting-connection--disconnected)
- [Connecting status](http://localhost:6006/?path=/story/audioshare-connection-status--connecting)
- [Reconnecting status](http://localhost:6006/?path=/story/audioshare-connection-status--reconnecting)
- [Keyboard tooltip](http://localhost:6006/?path=/story/audioshare-control-hint--keyboard-focus)
- [Dialog focus](http://localhost:6006/?path=/story/audioshare-meeting-dialog--focus-and-escape)
- [Participant layouts](http://localhost:6006/?path=/story/audioshare-meeting-stage--participants)
- [Unauthenticated room access](http://localhost:6006/?path=/story/audioshare-room-access--unauthenticated)
