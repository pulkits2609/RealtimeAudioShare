# Design

## Source of truth
Active, 15 November 2026. AudioShare's Tauri and browser meeting client. The user-approved `requirements/meeting-redesign.txt` expands this contract and supersedes the earlier frontend-preview restriction. Evidence reviewed: the Electron browser meeting/capture/room controllers, existing design contract, native WASAPI helper and permission policies, and this project's Storybook and component registry configuration.

## Brand
Calm, precise, welcoming. Preserve the existing warm neutral background, white surfaces, restrained orange accent, and AudioShare wordmark. State preview status honestly.

## Product goals
Preserve AudioShare's existing meeting capabilities in a Tauri window: real server connections, microphones, cameras, screens, shared audio, chat, per-source listening, quality controls, diagnostics and managed rooms. Keep the disconnected connection form centered. Add clear progress, recovery and permission feedback and optional quiet event sounds. Success is measured by regression tests and real local meeting sessions, not simulated connection success.

## Personas and jobs
Hosts sharing audio and screens, participants talking and watching, and room owners managing access. Desktop users need native output capture; browser users retain supported browser capture and explicit limitations.

## Information architecture
Disconnected: centered connection card, appearance/sound preferences and explicit microphone/camera OFF defaults. Connected: one stable meeting canvas, independent participant/screen/device-audio tiles, Auto/Grid/Focus layouts and local multiple pins. A persistent toolbar exposes media, deafen, chat, participants, authorized room management, settings and a separate Leave action. Settings use a focus-contained drawer; chat and participants resize the canvas without remounting media. TLS and token fields remain under Connection options. Narrow windows move secondary actions into More.

## Design principles
Reuse proven controls and controllers. Clearly distinguish pending, live, recovering, denied and unavailable states. Never fabricate participants, latency, audio activity or connection success. Stop controls remain available during failures. Permissions require deliberate user actions. Never let optional notification sounds interrupt joining or leak into captured audio.

## Visual language
Warm neutral background, white surfaces, dark ink and restrained orange actions; muted green for actual connected states. Preserve the established dark theme. System font stack, 420px connection card, fluid meeting layout, rounded controls and subtle static shadows. Use short opacity/transform transitions only when helpful; reduced motion disables them. Loading indicators represent pending operations, never live audio.

## Components
Preserve ThemeToggle, RoomManager, InvitationHistory and existing media forms. Extend MeetingStage with stable-key source tiles, local pin/focus preferences and source-specific volume/quality controls. Add connection status, Radix tooltips and a focus-contained settings dialog. Shared legacy tokens live in `src/meeting/style.css` and `theme.css`; `meeting-polish.css` and `stage-layout.css` adapt the meeting shell. `src/components.css` bridges Tailwind/shadcn tokens without Preflight. Motion handles short position/opacity transitions without replacing live video DOM elements.

## Accessibility
Target WCAG 2.2 AA. Native form semantics, associated labels, visible keyboard focus, native numeric/range and room-pattern validation, live status feedback, reduced-motion support, and no color-only state communication.

## Responsive behavior
Center in both axes when content fits. Keep natural page scrolling at short heights, high zoom, or when options expand. Fluid card width with 16px mobile gutters and a compact port column.

## Interaction states
Disconnected, connecting with Cancel, connected with measured duration, reconnecting, failed and recoverable playback block. Devices distinguish enumeration, empty and unavailable. Media controls show pending/active/off and role restrictions. Chat indicates sending/errors/unread; room management preserves actual server permissions and errors. Story mocks are isolated from production code.

## Content voice
Reuse existing field and action names. Describe actual failures and recovery actions. Label the browser client and desktop client accurately; do not claim encryption beyond the configured transport or hardware capability that has not been verified.

## Implementation constraints
Retain React 19, TypeScript, Vite and LiveKit 2.23. The Rust host replaces Electron IPC and supervises the existing C# WASAPI engine as a bundled helper; no Electron runtime is required. Capture uses bounded binary streaming, teardown and cancellation. Existing external LiveKit/session infrastructure and protocol remain compatible. Never persist credentials. Browser checks use fake media or explicit capture mocks and do not prove native hardware behavior. Build frontend, Storybook and native targets; verify the changed flows separately.

## Open questions
- [ ] Hardware acceptance: real microphone/camera selection, WebView2 screen picker, process exclusion with two-way listening, device unplug/replug, minimized playback and Internet NAT/firewall behavior. Owner: desktop acceptance.
- [ ] Broader services such as persistent direct messaging, recording and cloud history need explicit product requirements; do not invent services, telemetry or stored audio.
- [ ] Preserve public deployment: API/signaling `https://vps.pulkitworks.info:9999`, optional frontend port 9998, media UDP 9996 and TCP 9997, relative `/media`, `run.bat 9999 9998 9996 9997`, exact CORS, owner/invitation access, Android companions and separate source tracks. Local test ports are separate and never rewrite deployment settings.
