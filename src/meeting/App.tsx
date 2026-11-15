import React, { useEffect, useRef, useState } from 'react';
import type { Room, Metrics, ChatMessage, MicrophoneState } from './room';
import { startCapture, startScreenCapture, type Capture, type ScreenCapture } from './capture';
import { defaultConnectionPort, serverUrl } from './protocol';
import { type AudioQuality, type VideoQuality, type VideoFps, type SharingMode } from './video-policy';
import type { OutputDevice, Peer, RemoteVideo, CaptureMode } from './types';
import './style.css';
import './workspace.css';
import './theme.css';
import './meeting.css';
import './meeting-polish.css';
import { ControlHint } from '../components/ui/control-hint';
import { ConnectionStatus } from '../components/ui/connection-status';
import { NotificationSounds, type NotificationSound } from './sounds';
import { MeetingDialog } from '../components/ui/meeting-dialog';
import { motion, useReducedMotion } from 'motion/react';
import { MeetingStage } from './MeetingStage';
import { ThemeToggle } from './ThemeToggle';
import { RoomManager } from './RoomManager';
import { accessRequest, loginIfManaged, type AccessSession, type ManagedRoom } from './room-access';

type Status = 'offline' | 'connecting' | 'connected' | 'reconnecting';
type AudioSession = { stop(): Promise<void>; analyser?: AnalyserNode; fromScreen: boolean };
const emptyMetrics: Metrics = { rtt: null, jitter: null, loss: 0, sent: 0, received: 0, connected: 0 };
const videoOptions: { value: VideoQuality; label: string }[] = [
  { value: 'auto', label: 'Auto · up to 1080p' }, { value: '720p', label: '720p · lighter connection' },
  { value: '1080p', label: '1080p · full HD' }, { value: '1440p', label: '1440p · high detail' }, { value: '4k', label: '4K · maximum detail' },
];
const audioOptions: { value: AudioQuality; label: string }[] = [
  { value: 'adaptive', label: 'Adaptive · network aware' }, { value: 'music', label: 'Music · high quality stereo' }, { value: 'studio', label: 'Studio · highest bitrate' },
];
function saved(key: string, fallback: string) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function Icon({ kind, size = 20 }: { kind: 'sound' | 'arrow' | 'headphones' | 'server' | 'stop' | 'screen' | 'plus' | 'mic' | 'camera' | 'chat' | 'leave'; size?: number }) {
  const paths = {
    sound: <><path d="M3 10h4l5-5v14l-5-5H3z"/><path d="M16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6"/>, headphones: <><path d="M4 14v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="12" width="5" height="9" rx="2"/><rect x="16" y="12" width="5" height="9" rx="2"/></>,
    server: <><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01m4-11h6m-6 11h6"/></>,
    stop: <rect x="5" y="5" width="14" height="14" rx="2"/>, screen: <><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/></>, plus: <path d="M12 5v14M5 12h14"/>,
    mic: <><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0m-7 7v3m-3 0h6"/></>,
    camera: <><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/></>,
    chat: <path d="M20 15a2 2 0 0 1-2 2H9l-5 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2zM8 9h8m-8 4h6"/>,
    leave: <path d="M10 5H4v14h6m3-3 4-4-4-4m-5 4h12"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

export default function App() {
  const desktop = Boolean(window.audioShareDesktop);
  const canCapture = desktop || window.isSecureContext;
  const [name, setName] = useState(saved('name', ''));
  const [host, setHost] = useState(saved('host', !desktop && location.protocol === 'https:' ? location.hostname : 'localhost'));
  const [port, setPort] = useState(saved('port', defaultConnectionPort(location.protocol, location.port, desktop)));
  const [roomName, setRoomName] = useState(saved('roomName', 'lobby'));
  const [secure, setSecure] = useState(!desktop && location.protocol === 'https:');
  const [panel, setPanel] = useState<'devices' | 'audio' | 'screens' | 'diagnostics' | 'connection' | 'sounds' | 'rooms' | null>(null);
  const panelTrigger = useRef<HTMLElement | null>(null);
  const peopleButton = useRef<HTMLButtonElement>(null);
  const peopleCloseButton = useRef<HTMLButtonElement>(null);
  const reducedMotion = useReducedMotion();
  const [deafened, setDeafened] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const moreControls = useRef<HTMLDivElement>(null);
  const [chatJump, setChatJump] = useState(false);
  const chatAtBottom = useRef(true);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState('default');
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;
  const chatButton = useRef<HTMLButtonElement>(null);
  const [unread, setUnread] = useState(0);
  const [videoFps, setVideoFps] = useState<VideoFps>(30);
  const [sharingMode, setSharingMode] = useState<SharingMode>('motion');
  const [sourceVolumes, setSourceVolumes] = useState<Record<string, number>>({});
  const [accessSession, setAccessSession] = useState<AccessSession | null>(null);
  const accessBase = useRef('');
  const accessCredential = useRef('');
  const [selfRole, setSelfRole] = useState('');
  const [publishAllowed, setPublishAllowed] = useState(true);
  const [shareAllowed, setShareAllowed] = useState(true);
  const [sourceSinks, setSourceSinks] = useState<Record<string, string>>({});
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<Status>('offline');
  const [soundVolume, setSoundVolume] = useState(() => { const value = Number(saved('audioshare.notificationVolume', '.5')); return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : .5; });
  const notificationVolume = useRef(soundVolume); notificationVolume.current = soundVolume;
  const [soundEvents, setSoundEvents] = useState<Partial<Record<NotificationSound, boolean>>>(() => { try { const value: unknown = JSON.parse(saved('audioshare.notificationEvents', '{}')); return value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<Record<NotificationSound, boolean>> : {}; } catch { return {}; } });
  const eventPreferences = useRef(soundEvents); eventPreferences.current = soundEvents;
  const [soundsEnabled, setSoundsEnabled] = useState(() => saved('audioshare.notificationSounds', 'on') !== 'off');
  const notificationSounds = useRef<NotificationSounds | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const connectedTime = useRef(0);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const deviceRefreshGeneration = useRef(0);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [videos, setVideos] = useState<RemoteVideo[]>([]);
  const [error, setError] = useState('');
  const [activity, setActivity] = useState<{ time: string; message: string }[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatFailure, setChatFailure] = useState('');
  const pendingChatPayload = useRef<{ id: string; text: string } | null>(null);
  const [microphone, setMicrophone] = useState(false);
  const [microphoneDesired, setMicrophoneDesired] = useState(false);
  const [micState, setMicState] = useState<MicrophoneState>('off');
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [inputId, setInputId] = useState('default');
  const [listenVoice, setListenVoice] = useState(false), [listenShared, setListenShared] = useState(false);
  const [captureMode, setCaptureMode] = useState<CaptureMode>('endpoint');
  const [exclusion, setExclusion] = useState(false);
  const [exclusionReason, setExclusionReason] = useState('');
  const [microphoneBusy, setMicrophoneBusy] = useState(false);
  const [lobby, setLobby] = useState<{ groupId: number; channelId: number; serverInstance: string } | null>(null);
  const chatLog = useRef<HTMLDivElement>(null);
  const chatInput = useRef<HTMLTextAreaElement>(null);
  const chatPending = useRef(false), microphonePending = useRef(false);
  const [sharing, setSharing] = useState(false);
  const [videoSharing, setVideoSharing] = useState(false);
  const [audioBusy, setAudioBusy] = useState(false);
  const [videoBusy, setVideoBusy] = useState(false);
  const [audioQualityBusy, setAudioQualityBusy] = useState(false);
  const [videoQualityBusy, setVideoQualityBusy] = useState(false);
  const [audioQuality, setAudioQuality] = useState<AudioQuality>('adaptive');
  const [videoQuality, setVideoQuality] = useState<VideoQuality>('auto');
  const [includeScreenAudio, setIncludeScreenAudio] = useState(true);
  const [receiveVideo, setReceiveVideo] = useState(true);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const [cameraPreview, setCameraPreview] = useState<MediaStream | null>(null);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [cameraState, setCameraState] = useState<MicrophoneState>('off');
  const [cameraDesired, setCameraDesired] = useState(false);
  const cameraPending = useRef(false);
  const cameraGeneration = useRef(0);
  const [devices, setDevices] = useState<OutputDevice[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [sinkId, setSinkId] = useState('');
  const [metrics, setMetrics] = useState(emptyMetrics);
  const [states, setStates] = useState<Record<string, string>>({});
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const [blocked, setBlocked] = useState(false);
  const [level, setLevel] = useState(0);
  const room = useRef<Room | null>(null);
  const audio = useRef<AudioSession | null>(null);
  const audioAbort = useRef<AbortController | null>(null);
  const screen = useRef<ScreenCapture | null>(null);
  const connectionGeneration = useRef(0), audioGeneration = useRef(0), videoGeneration = useRef(0);
  const stopAudioRef = useRef<(client?: Room | null) => Promise<void>>(async () => {});
  const stopVideoRef = useRef<(client?: Room | null) => Promise<void>>(async () => {});
  const connected = status === 'connected';
  const inRoom = connected || status === 'reconnecting';
  const outgoingCapture = sharing || audioBusy || videoSharing || videoBusy || microphone || microphoneBusy || Boolean(cameraPreview) || cameraBusy;
  const notificationAllowed = useRef(false);
  notificationAllowed.current = soundsEnabled && !deafened && !outgoingCapture;
  useEffect(() => { if (outgoingCapture || !soundsEnabled) notificationSounds.current?.silence(); }, [outgoingCapture, soundsEnabled]);

  useEffect(() => {
    try { localStorage.setItem('audioshare.notificationSounds', soundsEnabled ? 'on' : 'off'); localStorage.setItem('audioshare.notificationVolume', String(soundVolume)); localStorage.setItem('audioshare.notificationEvents', JSON.stringify(soundEvents)); } catch { /* Optional preference. */ }
  }, [soundsEnabled, soundVolume, soundEvents]);
  useEffect(() => () => notificationSounds.current?.close(), []);
  useEffect(() => {
    if (status === 'offline') { connectedTime.current = 0; setElapsed(0); return; }
    if (status !== 'connected') return;
    const started = performance.now();
    const update = () => setElapsed(connectedTime.current + performance.now() - started);
    update();
    const interval = window.setInterval(update, 1000);
    return () => { connectedTime.current += performance.now() - started; setElapsed(connectedTime.current); window.clearInterval(interval); };
  }, [status]);
  const previousStatus = useRef<Status>('offline');
  useEffect(() => {
    const previous = previousStatus.current; previousStatus.current = status;
    if (!notificationAllowed.current) return;
    if (status === 'connected' && previous !== 'connected') playNotification(previous === 'reconnecting' ? 'connectionRestored' : 'connected');
    else if (status === 'reconnecting' && previous === 'connected') playNotification('connectionLost');
    else if (status === 'offline' && (previous === 'connected' || previous === 'reconnecting')) playNotification('disconnected');
  }, [status]);
  const previousPeers = useRef<Set<string> | null>(null);
  const peerSoundTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(peerSoundTimer.current), []);
  useEffect(() => {
    if (!connected) { previousPeers.current = null; clearTimeout(peerSoundTimer.current); return; }
    const next = new Set(peers.map(peer => peer.id));
    const previous = previousPeers.current; previousPeers.current = next;
    if (!previous || !notificationAllowed.current) return;
    const cue = [...next].some(id => !previous.has(id)) ? 'peerJoined' : [...previous].some(id => !next.has(id)) ? 'peerLeft' : null;
    if (cue) { clearTimeout(peerSoundTimer.current); peerSoundTimer.current = setTimeout(() => playNotification(cue), 250); }
  }, [peers, connected]);

  function playNotification(event: NotificationSound) {
    if (notificationAllowed.current && eventPreferences.current[event] !== false) notificationSounds.current?.play(event, notificationVolume.current);
  }
  const lastActionError = useRef('');
  useEffect(() => {
    if (error && error !== lastActionError.current) playNotification('failure');
    lastActionError.current = error;
  }, [error]);
  const previousSharing = useRef(false);
  const pendingShareSound = useRef<NotificationSound | null>(null);
  useEffect(() => {
    const active = sharing || videoSharing;
    if (active !== previousSharing.current) { pendingShareSound.current = active ? 'sharingStarted' : 'sharingStopped'; previousSharing.current = active; }
    if (!audioBusy && !videoBusy && pendingShareSound.current) {
      if (connected) playNotification(pendingShareSound.current);
      pendingShareSound.current = null;
    }
  }, [sharing, videoSharing, audioBusy, videoBusy, connected]);
  useEffect(() => { room.current?.muteIncoming(deafened); }, [deafened]);
  function showPanel(next: NonNullable<typeof panel>, trigger?: HTMLElement) {
    const current = trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    panelTrigger.current = moreOpen && current?.closest('.secondary-controls') ? moreButton.current : current;
    setPanel(next); setMoreOpen(false);
  }
  function closePeople() { setPeopleOpen(false); if (peopleButton.current?.getClientRects().length) peopleButton.current.focus(); else moreButton.current?.focus(); }
  function togglePeople() { if (peopleOpen) closePeople(); else { setPeopleOpen(true); setChatOpen(false); setMoreOpen(false); } }
  useEffect(() => {
    if (!moreOpen) return;
    moreControls.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !moreControls.current?.contains(event.target) && !moreButton.current?.contains(event.target)) setMoreOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [moreOpen]);
  useEffect(() => { if (peopleOpen) peopleCloseButton.current?.focus(); }, [peopleOpen]);
  function jumpToLatest() { const element = chatLog.current; if (element) element.scrollTop = element.scrollHeight; chatAtBottom.current = true; setChatJump(false); }

  useEffect(() => {
    if (!inRoom) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && document.fullscreenElement) {
        event.preventDefault();
        void document.exitFullscreen().catch(() => setError('Fullscreen could not close. Use the browser fullscreen control.'));
        return;
      }
      const target = event.target;
      if (event.repeat || event.isComposing || (target instanceof HTMLElement && target.closest('input,textarea,select,[contenteditable="true"]'))) return;
      if (event.key === 'Escape' && !panel) {
        if (chatOpen) closeChat(); else if (peopleOpen) closePeople(); else { setMoreOpen(false); moreButton.current?.focus(); }
        return;
      }
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || panel) return;
      const labels: Record<string, string> = {
        KeyM: microphoneDesired ? 'Turn off microphone' : 'Turn on microphone',
        KeyV: cameraDesired || cameraPreview || cameraBusy ? 'Turn off camera' : 'Turn on camera',
        KeyD: deafened ? 'Undeafen' : 'Deafen', KeyC: 'Chat',
      };
      const label = labels[event.code]; if (!label) return;
      const button = document.querySelector<HTMLButtonElement>(`.meeting-dock button[aria-label="${label}"]`);
      if (button && !button.disabled) { event.preventDefault(); button.click(); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [inRoom, panel, chatOpen, peopleOpen, microphoneDesired, cameraDesired, cameraPreview, cameraBusy, deafened]);

  function log(text: string) { setActivity(old => [{ time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), message: text }, ...old].slice(0, 50)); }
  async function stopAudio(client = room.current) {
    const operation = ++audioGeneration.current;
    audioAbort.current?.abort(); audioAbort.current = null;
    const source = audio.current; audio.current = null;
    setSharing(false); setAudioBusy(true); setLevel(0);
    const stopped = source?.stop().catch(e => { if (operation === audioGeneration.current) setError(`Could not stop audio: ${message(e)}`); });
    try { await client?.share(null); } catch { /* A disconnected room already releases publications. */ }
    await stopped;
    if (operation === audioGeneration.current) { client?.captureRouting(false); setAudioBusy(false); }
    if (source) log('You stopped sharing audio.');
  }
  async function stopVideo(client = room.current) {
    const operation = ++videoGeneration.current;
    const source = screen.current; screen.current = null;
    setVideoSharing(false); setPreview(null); setVideoBusy(true);
    const stopped = source?.stop().catch(e => { if (operation === videoGeneration.current) setError(`Could not stop screen sharing: ${message(e)}`); });
    if (audio.current?.fromScreen) await stopAudioRef.current(client);
    try { await client?.shareVideo(null, videoQuality); } catch { /* Room cleanup owns a disconnected publication. */ }
    await stopped;
    if (operation === videoGeneration.current) setVideoBusy(false);
    if (source) log('You stopped sharing your screen.');
  }
  stopAudioRef.current = stopAudio; stopVideoRef.current = stopVideo;
  useEffect(() => () => {
    connectionGeneration.current++; audioGeneration.current++; videoGeneration.current++;
    audioAbort.current?.abort();
    const client = room.current; room.current = null; client?.close(); void audio.current?.stop(); void screen.current?.stop();
  }, []);

  useEffect(() => {
    const element = chatLog.current;
    if (chatOpen && element) { if (chatAtBottom.current) element.scrollTop = element.scrollHeight; else setChatJump(true); }
  }, [chat, chatOpen]);
  useEffect(() => {
    if (chatOpen) {
      setUnread(0);
      chatInput.current?.focus({ preventScroll: true });
    }
  }, [chatOpen]);

  function openChat() {
    if (chatOpen) { closeChat(); return; }
    setPeopleOpen(false); setChatOpen(true); setMoreOpen(false);
  }

  function closeChat() {
    setChatOpen(false);
    if (chatButton.current?.getClientRects().length) chatButton.current.focus(); else moreButton.current?.focus();
  }

  function resetCamera() {
    cameraGeneration.current++; cameraPending.current = false;
    setCameraDesired(false); setCameraState('off'); setCameraBusy(false);
    setCameraPreview(null);
  }

  async function refreshDevices() {
    const generation = ++deviceRefreshGeneration.current; setDevicesLoading(true);
    // Native output enumeration must not block unrelated microphone discovery.
    const native = window.audioShareDesktop?.listOutputDevices().then(result => {
      if (result) { setDevices(result.devices); setDeviceId(old => result.devices.some(d => d.id === old) ? old : result.defaultDeviceId || result.devices[0]?.id || ''); }
    }).catch(e => setError(`Could not list shared-audio sources: ${message(e)}`));
    try {
      if (navigator.mediaDevices?.enumerateDevices) { const list = await navigator.mediaDevices.enumerateDevices(); setOutputs(list.filter(d => d.kind === 'audiooutput')); setInputs(list.filter(d => d.kind === 'audioinput')); setCameras(list.filter(d => d.kind === 'videoinput')); }
      await room.current?.recoverDevices();
    } catch (e) { setError(`Could not refresh microphones/playback: ${message(e)}`); }
    await native;
    if (generation === deviceRefreshGeneration.current) setDevicesLoading(false);
  }
  useEffect(() => {
    void refreshDevices();
    void window.audioShareDesktop?.getCaptureCapabilities?.().then(result => { setExclusion(result.processExclusion); setExclusionReason(result.reason || ''); if (result.processExclusion) { setCaptureMode('exclude-self'); setListenVoice(true); setListenShared(true); } }).catch(() => {});
    const changed = () => { void refreshDevices(); };
    navigator.mediaDevices?.addEventListener('devicechange', changed);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', changed);
  }, []);
  useEffect(() => { room.current?.listeningWhileSharing(listenVoice, listenShared); }, [listenVoice, listenShared]);
  useEffect(() => {
    if (!inRoom) { setMetrics(emptyMetrics); return; }
    let pending = false, active = true;
    const client = room.current;
    const interval = setInterval(() => {
      if (!client || pending) return; pending = true;
      void client.metrics().then(value => { if (active && room.current === client) setMetrics(value); }).catch(() => {}).finally(() => { pending = false; });
    }, 1200);
    return () => { active = false; clearInterval(interval); };
  }, [inRoom]);
  useEffect(() => {
    if (!sharing) return;
    const analyser = audio.current?.analyser; if (!analyser) return;
    const values = new Uint8Array(analyser.frequencyBinCount);
    const interval = setInterval(() => {
      analyser.getByteFrequencyData(values);
      setLevel(values.reduce((sum, value) => sum + value, 0) / (values.length * 255));
    }, 100);
    return () => clearInterval(interval);
  }, [sharing]);

  function disconnect() {
    connectionGeneration.current++; setPanel(null); setChatOpen(false); setPeopleOpen(false); setMoreOpen(false);
    const client = room.current; room.current = null;
    client?.close(); setStatus('offline'); setPeers([]); setVideos([]); setBlocked(false);
    resetCamera();
    setMicrophone(false); setMicrophoneDesired(false); setMicState('off'); setMicrophoneBusy(false); microphonePending.current = false; setLobby(null); setChatBusy(false); chatPending.current = false;
    void stopAudioRef.current(client); void stopVideoRef.current(client); log('You left the room.');
  }
  async function join(event: React.FormEvent) {
    event.preventDefault(); if (status !== 'offline') return;
    setError('');
    if (!name.trim() || name.trim().length > 40) { setError('Enter a name between 1 and 40 characters.'); return; }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(roomName.trim())) { setError('Use 1–64 letters, numbers, underscores or hyphens for the room name.'); return; }
    let url: string;
    try { url = serverUrl(host, port, secure); } catch (e) { setError(message(e)); return; }
    if (!desktop && location.protocol === 'https:' && !secure) { setError('This HTTPS page needs a secure WSS server. Enable TLS and configure HTTPS on your server.'); return; }
    notificationSounds.current ??= new NotificationSounds();
    if (soundsEnabled) void notificationSounds.current.unlock();
    const operation = ++connectionGeneration.current;
    setStatus('connecting'); setSelfRole(''); setBlocked(false); setStates({}); setPeers([]); setVideos([]);
    setPanel(null); setPeopleOpen(false); setUnread(0); resetCamera();
    setChat([]); setDraft(''); setChatFailure(''); pendingChatPayload.current = null; setChatBusy(false); chatPending.current = false; setMicrophone(false); setMicrophoneBusy(false); microphonePending.current = false; setLobby(null);
    try { const unlock = new AudioContext(); await unlock.resume(); await unlock.close(); }
    catch { if (operation === connectionGeneration.current) { setError('Audio playback could not initialize. Try joining again in Chrome or Edge.'); setStatus('offline'); } return; }
    if (operation !== connectionGeneration.current) return;
    let RoomClient: typeof import('./room').Room;
    try { ({ Room: RoomClient } = await import('./room')); }
    catch { if (operation === connectionGeneration.current) { setError('The media client could not load. Refresh the application and try again.'); setStatus('offline'); } return; }
    if (operation !== connectionGeneration.current) return;
    const old = room.current; room.current = null; old?.close();
    const client = new RoomClient({
      peers: list => { if (room.current === client) setPeers(list); },
      videos: list => { if (room.current === client) setVideos(list); },
      status: next => {
        if (room.current !== client) return; setStatus(next);
        if (next === 'offline') {
          void stopAudioRef.current(client);
          void stopVideoRef.current(client);
          setPeers([]);
          setVideos([]);
          resetCamera();
          setMicrophone(false);
          setMicrophoneBusy(false);
          microphonePending.current = false;
          setLobby(null);
        }
      },
      chat: item => { if (room.current === client) { if (!item.local && (!chatOpenRef.current || document.hidden)) playNotification('message'); setChat(old => [...old, item].slice(-200)); if (!item.local && !chatOpenRef.current) setUnread(old => old + 1); } },
      microphone: enabled => { if (room.current === client) setMicrophone(enabled); },
      camera: stream => { if (room.current === client) setCameraPreview(stream); },
      cameraState: (value, desired) => { if (room.current === client) { setCameraState(value); setCameraDesired(desired); setCameraBusy(value === 'starting'); } },
      permissions: value => { if (room.current === client) { setPublishAllowed(value.canPublish); setShareAllowed(value.canShare); setSelfRole(value.role || ''); } },
      microphoneState: (value, desired) => { if (room.current === client) { setMicState(value); setMicrophoneDesired(desired); setMicrophoneBusy(value === 'starting'); } },
      output: id => { if (room.current === client) setSinkId(id); },
      lobby: value => { if (room.current === client) setLobby(value); },
      activity: text => { if (room.current === client) log(text); },
      error: text => { if (room.current === client) setError(text); },
      playbackBlocked: value => { if (room.current === client) setBlocked(value); },
      transport: (id, value) => { if (room.current === client) setStates(oldStates => ({ ...oldStates, [id]: value })); },
    });
    room.current = client; void client.cameraInput(cameraId).catch(error => { if (room.current === client) setError(`Camera: ${message(error)}`); }); client.muteIncoming(deafened); client.listeningWhileSharing(listenVoice, listenShared); void client.microphoneInput(inputId); client.receiveVideo(receiveVideo);
    try {
      await client.output(sinkId);
      if (operation !== connectionGeneration.current || room.current !== client) return;
      await client.setAudioQuality(audioQuality);
      if (operation !== connectionGeneration.current || room.current !== client) return;
      let session = accessSession;
      if (accessBase.current !== url || (session && session.expiresAt <= Date.now())) session = null;
      if (session && token.trim() && accessCredential.current !== token.trim()) {
        const previous = session; session = null; setAccessSession(null);
        await accessRequest(url, '/v1/auth/logout', previous, {}).catch(() => {});
      }
      if (!session) session = await loginIfManaged(url, name.trim(), token);
      if (operation !== connectionGeneration.current || room.current !== client) return;
      setAccessSession(session); accessBase.current = url; accessCredential.current = token.trim();
      let targetRoom = roomName.trim();
      if (session) {
        const result = await accessRequest<{ rooms: ManagedRoom[] }>(url, '/v1/rooms', session);
        if (!result.rooms.some(value => value.name === targetRoom)) {
          if (session.owner) await accessRequest(url, '/v1/rooms', session, { name: targetRoom });
          else if (result.rooms.length) { targetRoom = result.rooms[0].name; setRoomName(targetRoom); }
          else throw new Error('No accessible rooms remain. Ask the owner for a new invitation.');
        }
      }
      if (operation !== connectionGeneration.current || room.current !== client) return;
      await client.connect(url, name.trim(), token, targetRoom, session?.accessToken);
      await client.videoPolicy(videoFps, sharingMode);
      if (operation !== connectionGeneration.current || room.current !== client) { client.close(); return; }
      try { for (const [key, value] of Object.entries({ name, host, port, roomName })) localStorage.setItem(key, value); } catch { /* Optional preferences. Access tokens are never saved. */ }
    } catch (e) {
      if (room.current === client && operation === connectionGeneration.current) { setError(message(e)); client.close(); setStatus('offline'); }
    }
  }
  async function startAudio() {
    const client = room.current; if (!connected || !client || audioBusy || audio.current) return;
    notificationAllowed.current = false; notificationSounds.current?.silence();
    const operation = ++audioGeneration.current; setError(''); setAudioBusy(true); client.captureRouting(true, desktop && captureMode === 'exclude-self');
    const abort = new AbortController(); audioAbort.current?.abort(); audioAbort.current = abort;
    let source: Capture | undefined;
    try {
      source = await startCapture(deviceId, () => { if (operation === audioGeneration.current && room.current === client) void stopAudioRef.current(client); }, abort.signal, captureMode);
      if (operation !== audioGeneration.current || room.current !== client) { await source.stop(); return; }
      const activeSource = source;
      audio.current = { stop: () => activeSource.stop(), analyser: source.analyser, fromScreen: false };
      await client.share(source.stream.getAudioTracks()[0]);
      if (operation !== audioGeneration.current || room.current !== client) return;
      setSharing(true); log('You started sharing audio. Listening follows your sharing preferences.');
    } catch (e) {
      if (operation !== audioGeneration.current || room.current !== client) return;
      audio.current = null; await source?.stop().catch(() => {}); await client.share(null).catch(() => {});
      if (operation === audioGeneration.current && room.current === client) { client.captureRouting(false); setError(message(e)); }
    } finally { if (operation === audioGeneration.current) setAudioBusy(false); }
  }
  async function startVideo() {
    const client = room.current; if (!connected || !client || videoBusy || screen.current) return;
    notificationAllowed.current = false; notificationSounds.current?.silence();
    const operation = ++videoGeneration.current; setError(''); setVideoBusy(true);
    let source: ScreenCapture | undefined;
    try {
      source = await startScreenCapture(videoQuality, () => { if (operation === videoGeneration.current && room.current === client) void stopVideoRef.current(client); }, videoFps, sharingMode);
      if (operation !== videoGeneration.current || room.current !== client) { await source.stop(); return; }
      screen.current = source;
      const videoTrack = source.stream.getVideoTracks()[0]; if (!videoTrack) throw new Error('The selected source did not include video. Choose a screen or window and try again.');
      await client.shareVideo(videoTrack, videoQuality);
      if (operation !== videoGeneration.current || room.current !== client) return;
      setVideoSharing(true); setPreview(source.stream); log('You started sharing your screen.');
      if (includeScreenAudio && !audio.current && !audioBusy) {
        if (desktop) await startAudio();
        else {
          const track = source.stream.getAudioTracks()[0];
          if (track) {
            const audioOperation = ++audioGeneration.current; client.captureRouting(true);
            audio.current = { fromScreen: true, stop: async () => { track.stop(); } };
            try {
              await client.share(track);
              if (audioOperation === audioGeneration.current && room.current === client) { setSharing(true); log('Screen audio is sharing. Listening follows your sharing preferences.'); }
            } catch (e) { if (audioOperation === audioGeneration.current && room.current === client) { await stopAudioRef.current(client); setError(`Video is sharing, but audio could not start: ${message(e)}`); } }
          } else log('Screen is sharing without audio. Enable “Share audio” in the browser picker to include sound.');
        }
      }
    } catch (e) {
      if (operation !== videoGeneration.current || room.current !== client) return;
      screen.current = null; setPreview(null); setVideoSharing(false); await source?.stop().catch(() => {}); await client.shareVideo(null, videoQuality).catch(() => {});
      if (operation === videoGeneration.current && room.current === client) setError(message(e));
    } finally { if (operation === videoGeneration.current) setVideoBusy(false); }
  }
  async function changeAudioQuality(value: AudioQuality) {
    const client = room.current; if (!client || !inRoom) { setAudioQuality(value); return; }
    setAudioQualityBusy(true);
    try { await client.setAudioQuality(value); if (room.current === client) setAudioQuality(value); }
    catch (e) { if (room.current === client) setError(`Could not change audio quality: ${message(e)}`); }
    finally { setAudioQualityBusy(false); }
  }
  async function changeVideoQuality(value: VideoQuality) {
    const client = room.current; if (!client || !inRoom) { setVideoQuality(value); return; }
    setVideoQualityBusy(true);
    try { await client.setVideoQuality(value); if (room.current === client) setVideoQuality(value); }
    catch (e) { if (room.current === client) setError(`Could not change video quality: ${message(e)}`); }
    finally { setVideoQualityBusy(false); }
  }
  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    const client = room.current, text = draft.trim(), operation = connectionGeneration.current;
    if (!connected || !client || chatPending.current || !text) return;
    if (pendingChatPayload.current?.text !== text) pendingChatPayload.current = { id: crypto.randomUUID(), text };
    const payload = pendingChatPayload.current;
    chatInput.current?.focus({ preventScroll: true });
    chatPending.current = true; setChatBusy(true); setChatFailure('');
    try {
      await client.sendChat(text, payload.id);
      if (room.current === client && operation === connectionGeneration.current) { setDraft(current => current.trim() === text ? '' : current); if (pendingChatPayload.current?.id === payload.id) pendingChatPayload.current = null; }
    } catch (e) { if (room.current === client && operation === connectionGeneration.current) { setChatFailure(`Sending could not be confirmed: ${message(e)} Retry keeps the same message ID.`); playNotification('failure'); } }
    finally { if (room.current === client && operation === connectionGeneration.current) { chatPending.current = false; setChatBusy(false); } }
  }
  async function toggleMicrophone() {
    const client = room.current, operation = connectionGeneration.current;
    if (!client || (!microphoneDesired && (!connected || !canCapture))) return;
    if (!microphoneDesired) { notificationAllowed.current = false; notificationSounds.current?.silence(); }
    setError('');
    try { await client.setMicrophone(!microphoneDesired); await refreshDevices(); }
    catch (e) { if (room.current === client && operation === connectionGeneration.current) setError(`Microphone: ${message(e)}`); }
  }
  async function toggleCamera() {
    const client = room.current; if (!client) return;
    if (cameraDesired || cameraPreview || cameraBusy) {
      cameraGeneration.current++; cameraPending.current = false; setCameraDesired(false); setCameraState('off'); setCameraBusy(false); setCameraPreview(null);
      try { await client.camera(false); } catch (error) { if (room.current === client) setError(`Camera: ${message(error)}`); }
      return;
    }
    if (!connected || !canCapture || !shareAllowed) return;
    const operation = connectionGeneration.current, generation = ++cameraGeneration.current;
    notificationAllowed.current = false; notificationSounds.current?.silence(); setError(''); cameraPending.current = true; setCameraBusy(true);
    try {
      const stream = await client.camera(true);
      if (room.current === client && operation === connectionGeneration.current && generation === cameraGeneration.current) setCameraPreview(stream?.getVideoTracks().some(track => track.readyState === 'live') ? stream : null);
    } catch (error) {
      if (room.current === client && operation === connectionGeneration.current && generation === cameraGeneration.current) setError(`Camera: ${message(error)}`);
    } finally {
      if (room.current === client && operation === connectionGeneration.current && generation === cameraGeneration.current) { cameraPending.current = false; setCameraBusy(false); }
    }
  }

  async function chooseOutput() {
    const client = room.current;
    try {
      const api = navigator.mediaDevices as MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> };
      if (api?.selectAudioOutput) { const selected = await api.selectAudioOutput(); await client?.output(selected.deviceId); if (room.current === client) setSinkId(selected.deviceId); }
      await refreshDevices();
    } catch (e) { setError(`Could not choose playback output: ${message(e)}`); }
  }
  const streams = peers.filter(peer => peer.streaming || peer.videoStreaming).length + Number(sharing || videoSharing);
  const audioLabel = audioOptions.find(option => option.value === audioQuality)!.label.split(' · ')[0];
  const connectionPanel = <>        <section className="card connection-panel"><div className="card-heading"><span className="icon-box"><Icon kind="server"/></span><div><h2>Your connection</h2><p>One room. Audio and video together.</p></div></div>
          <form onSubmit={join} aria-busy={status === 'connecting'}><label htmlFor="name">Your name</label><input id="name" autoComplete="nickname" placeholder="e.g. Pulkit" maxLength={40} value={name} onChange={event => setName(event.target.value)} disabled={status !== 'offline'} required/>
            <div className="address-row"><div><label htmlFor="host">Server address</label><input id="host" placeholder="localhost" value={host} onChange={event => setHost(event.target.value)} disabled={status !== 'offline'} required spellCheck={false}/></div><div><label htmlFor="port">Port</label><input id="port" type="number" min={1} max={65535} step={1} inputMode="numeric" value={port} onChange={event => setPort(event.target.value)} disabled={status !== 'offline'} required/></div></div>
            <div className="field-space"><label htmlFor="room-name">Room</label><input id="room-name" value={roomName} onChange={event => setRoomName(event.target.value)} disabled={status !== 'offline'} maxLength={64} pattern="[a-zA-Z0-9_\-]{1,64}" required spellCheck={false}/></div>
            <details className="advanced"><summary>Connection options</summary><label className="check"><input type="checkbox" checked={secure} onChange={event => setSecure(event.target.checked)} disabled={status !== 'offline'}/>Use secure connection (TLS / WSS)</label><label htmlFor="token">Server access token</label><input id="token" type="password" value={token} onChange={event => setToken(event.target.value)} disabled={status !== 'offline'} autoComplete="off"/><p className="field-hint">Use an owner token or private invitation on managed servers. Shared join tokens work only when compatibility access is enabled.</p></details>
            {status === 'offline' ? <button key="join" className="button primary full" type="submit">Join server <Icon kind="arrow" size={18}/></button> : <button key="disconnect" className="button secondary full" type="button" onClick={event => { event.preventDefault(); disconnect(); }}>{status === 'connecting' ? 'Cancel connection' : 'Leave room'}</button>}
          </form>{!inRoom && <p className="prejoin-media"><Icon kind="mic" size={15}/> Microphone off <span>·</span><Icon kind="camera" size={15}/> Camera off</p>}<p className="form-note"><span className="tiny-dot"/>Media uses encrypted WebRTC. Use TLS for a secure server connection.</p>
        </section>
</>;
  const deviceSettings = <>        <section className="device-workspace" aria-label="Device and listening settings">
        <section className="card playback-panel"><h3>Listening preferences</h3><label htmlFor="playback">Playback device</label><select id="playback" value={sinkId} aria-busy={devicesLoading} disabled={!inRoom || devicesLoading} onChange={event => { const id = event.target.value, client = room.current; void client?.output(id).then(() => { if (room.current === client) setSinkId(id); }).catch(e => setError(`Playback device: ${message(e)}`)); }}><option value="">System default</option>{outputs.filter(device => device.deviceId && device.deviceId !== 'default').map((device, i) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Output ${i + 1}`}</option>)}</select><button className="text-button small" onClick={() => { void chooseOutput(); }}>{devicesLoading ? 'Finding devices…' : 'Refresh / choose device'}</button>{!devicesLoading && !outputs.length && <p className="field-hint">No named playback devices are available. System default remains selected.</p>}<label className="check receive-check"><input type="checkbox" checked={!receiveVideo} onChange={event => { const enabled = !event.target.checked; room.current?.receiveVideo(enabled); setReceiveVideo(enabled); }}/>Audio-only listening</label><p>Audio-only listening stops incoming video subscriptions to save bandwidth.</p></section>
        <section className="card playback-panel"><h3>Separate listening channels</h3><p>Microphone voice and shared audio are independent tracks. Route them to different playback devices if needed.</p>{(['microphone', 'screen_share_audio'] as const).map(source => <label key={source}>{source === 'microphone' ? 'Voice playback' : 'Shared-audio playback'}<select aria-label={source === 'microphone' ? 'Voice playback' : 'Shared-audio playback'} value={sourceSinks[source] || ''} onChange={event => { const id = event.target.value; void room.current?.outputSource(source, id).then(() => setSourceSinks(old => ({ ...old, [source]: id }))).catch(error => setError(message(error))); }}><option value="">Follow main playback device</option>{outputs.filter(device => device.deviceId && device.deviceId !== 'default').map((device, i) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Output ${i + 1}`}</option>)}</select></label>)}</section><section className="card playback-panel"><h3>Hear others while sharing</h3><label className="check"><input type="checkbox" checked={listenVoice} onChange={e => setListenVoice(e.target.checked)}/>Hear participants’ microphones</label><label className="check"><input type="checkbox" checked={listenShared} onChange={e => setListenShared(e.target.checked)}/>Hear participants’ shared audio</label><p>{desktop && captureMode === 'exclude-self' ? 'AudioShare playback is excluded from capture, so listening remains available.' : 'Off by default during sound sharing. Enabling either option can send listeners their own audio when capturing the same output. Use an output outside the captured route or Windows exclusion mode.'}</p></section>
        <section className="side-note"><Icon kind="headphones"/><h3>Give your sound some room.</h3><p>Choose what you hear while sharing. Headphones prevent acoustic feedback, but selected-output capture can still retransmit incoming playback.</p><div className="note-rule"/><span>QUALITY FOLLOWS YOUR CONNECTION</span></section>
          <div className="voice-controls"><div><h3>Voice chat</h3><p>Your microphone is separate from shared music and screen audio.</p>{lobby && <p className="lobby-details">Voice lobby · Group {lobby.groupId} · Channel {lobby.channelId}<span>Server instance: {lobby.serverInstance}</span></p>}</div></div>
          <label htmlFor="microphone-input">Microphone input</label><select id="microphone-input" aria-busy={devicesLoading} value={inputId} onChange={event => { const id = event.target.value; setInputId(id); void room.current?.microphoneInput(id).catch(e => setError(`Microphone: ${message(e)}`)); }}><option value="default">System default · follows device changes</option>{inputs.filter(d => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}{inputId !== 'default' && !inputs.some(d => d.deviceId === inputId) && <option value={inputId}>Selected microphone unavailable</option>}</select><p className="field-hint">{devicesLoading ? 'Finding microphones… ' : !inputs.length ? 'No microphones are listed. Check operating-system permissions or attach a microphone. ' : ''}A selected microphone waits for that device if unplugged. System default follows your operating system. {micState === 'unavailable' && microphoneDesired ? 'Microphone unavailable. Check the device or select another input.' : ''}</p>
          <label htmlFor="camera-input">Camera input</label><select id="camera-input" value={cameraId} onChange={event => { const id = event.target.value; setCameraId(id); void room.current?.cameraInput(id).catch(error => setError(`Camera: ${message(error)}`)); }}><option value="default">System default camera</option>{cameras.filter(device => device.deviceId && device.deviceId !== 'default').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}</select>{!devicesLoading && !cameras.length && <p className="field-hint">No camera is listed. Connect a camera and check your permissions.</p>}{cameraState === 'unavailable' && cameraDesired && <p className="field-hint">Camera unavailable. Reconnect the selected device, or turn it off and choose another camera.</p>}
          {!canCapture && <p className="field-hint">Microphone access requires HTTPS or localhost.</p>}
        </section>
</>;
  const audioSettings = <>        <section className={`card studio ${sharing ? 'is-live' : ''}`}><div className="studio-top"><span className="section-label">YOUR AUDIO</span><span className={`live-chip ${sharing ? 'active' : ''}`}><span className="tiny-dot"/>{sharing ? 'LIVE' : 'STANDBY'}</span></div>
          <div className="audio-studio-layout"><div><div className="waveform" aria-hidden="true">{Array.from({ length: 43 }, (_, i) => <span key={i} style={{ height: sharing ? `${6 + level * 85 * (0.3 + Math.abs(Math.sin(i * 1.8)) * 0.7)}px` : `${4 + Math.abs(Math.sin(i * 0.7)) * 10}px`, opacity: sharing ? 0.55 + level * 0.45 : 0.3 }}/>)}</div><div className="studio-copy"><h2>{sharing ? 'Your sound is in the room.' : 'Let everyone hear it.'}</h2><p>{sharing ? 'Sharing output audio · listening follows your preferences.' : 'Share music, a movie, or your device’s sound.'}</p></div></div><div className="audio-controls"><label htmlFor="audio-quality">Audio quality</label><select id="audio-quality" value={audioQuality} disabled={audioQualityBusy || audioBusy || status === 'reconnecting'} onChange={event => { void changeAudioQuality(event.target.value as AudioQuality); }}>{audioOptions.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
          {desktop && <div className="native-source"><label htmlFor="capture-mode">Capture scope</label><select id="capture-mode" value={captureMode} disabled={sharing || audioBusy} onChange={e => { const mode = e.target.value as CaptureMode; setCaptureMode(mode); setListenVoice(mode === 'exclude-self'); setListenShared(mode === 'exclude-self'); }}><option value="endpoint">Selected speaker / headset</option>{exclusion && <option value="exclude-self">All device sound except AudioShare</option>}</select>{!exclusion && <p className="field-hint">{exclusionReason || 'Playback exclusion is unavailable on this system.'}</p>}<label htmlFor="source">Capture from</label><div className="source-row"><select id="source" value={deviceId} aria-busy={devicesLoading} disabled={devicesLoading || sharing || audioBusy || captureMode === 'exclude-self'} onChange={event => setDeviceId(event.target.value)}>{devices.length ? devices.map(device => <option key={device.id} value={device.id}>{device.name}</option>) : <option value="">{devicesLoading ? 'Finding output devices…' : 'No output devices found'}</option>}</select><button className="text-button" disabled={devicesLoading || sharing || audioBusy} aria-busy={devicesLoading} onClick={() => { void refreshDevices(); }} aria-label="Refresh capture devices">↻</button></div></div>}
          <button className={`button share-button ${sharing ? 'stop' : 'dark'}`} aria-busy={audioBusy} onClick={() => { if (sharing || audioBusy) void stopAudio(); else void startAudio(); }} disabled={!audioBusy && !sharing && (!connected || !shareAllowed || !canCapture || (desktop && captureMode === 'endpoint' && !deviceId))}><Icon kind={sharing ? 'stop' : 'sound'}/>{audioBusy ? 'Cancel audio sharing' : sharing ? 'Stop sharing' : 'Share audio'}</button></div></div>
          <p className="capture-hint">{desktop ? captureMode === 'exclude-self' ? 'Captures all applications except AudioShare across device outputs. The selected speaker is not used in this mode.' : 'Choose the speaker or headset playing your audio.' : 'Select a tab or screen and enable “Share audio” in the browser picker.'}</p><div className="quality-strip"><span><span className="quality-dot"/>STEREO OPUS</span><span>{audioLabel} profile</span><span>48 kHz requested</span><span>Network adaptation</span></div>
        </section>
</>;
  const screenSettings = <>        <section className={`card screen-panel ${videoSharing ? 'screen-live' : ''}`}><div className="studio-top"><span className="section-label">YOUR SCREEN</span><span className={`live-chip ${videoSharing ? 'active' : ''}`}><span className="tiny-dot"/>{videoSharing ? 'SHARING' : 'READY'}</span></div><div className="screen-controls"><div className="screen-intro"><span className="screen-icon"><Icon kind="screen" size={28}/></span><div><h2>{videoSharing ? 'Your screen is live.' : 'Show the bigger picture.'}</h2><p>{videoSharing ? 'Only the selected source is shared. Stop at any time.' : 'Choose a screen or window. Video adapts to available bandwidth.'}</p></div></div><div className="screen-actions"><label htmlFor="video-fps">Frame rate (maximum)</label><select id="video-fps" value={videoFps} disabled={videoBusy || videoQualityBusy} onChange={event => { const fps = Number(event.target.value) as VideoFps; setVideoFps(fps); void room.current?.videoPolicy(fps, sharingMode).catch(error => setError(message(error))); }}>{[30,45,60].map(fps => <option key={fps} value={fps}>{fps} FPS</option>)}</select><label htmlFor="sharing-mode">Screen content</label><select id="sharing-mode" value={sharingMode} disabled={videoBusy || videoQualityBusy} onChange={event => { const mode = event.target.value as SharingMode; setSharingMode(mode); void room.current?.videoPolicy(videoFps, mode).catch(error => setError(message(error))); }}><option value="motion">Video / motion · smooth movement</option><option value="text">Text / desktop · sharp detail</option></select><label htmlFor="video-quality">Maximum video quality</label><select id="video-quality" value={videoQuality} disabled={videoQualityBusy || videoBusy || status === 'reconnecting'} onChange={event => { void changeVideoQuality(event.target.value as VideoQuality); }}>{videoOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><button className={`button ${videoSharing ? 'stop' : 'secondary'}`} aria-busy={videoBusy} onClick={() => { if (videoSharing || videoBusy) void stopVideo(); else void startVideo(); }} disabled={!videoBusy && !videoSharing && (!connected || !shareAllowed || !canCapture)}><Icon kind={videoSharing ? 'stop' : 'screen'}/>{videoBusy ? 'Cancel screen sharing' : videoSharing ? 'Stop screen sharing' : 'Share screen'}</button></div></div><label className="check screen-audio-check"><input type="checkbox" checked={includeScreenAudio} disabled={videoSharing || videoBusy} onChange={event => setIncludeScreenAudio(event.target.checked)}/>{desktop ? 'Also share the selected output device’s audio' : 'Include audio when the browser offers it'}</label><p className="field-hint">Quality is a maximum, not a guarantee. The selected source, hardware and network determine actual resolution and frame rate.</p></section>
</>;
  const connectionDiagnostics = <>        <section className="metrics" aria-label="Live media diagnostics"><div><span>NETWORK RTT</span><strong>{metrics.rtt === null ? '—' : Math.round(metrics.rtt)}<small> ms</small></strong></div><div><span>RECEIVE JITTER</span><strong>{metrics.jitter === null ? '—' : metrics.jitter.toFixed(1)}<small> ms</small></strong></div><div><span>AUDIO RATE</span><strong>{metrics.audioKbps === undefined ? '—' : Math.round(metrics.audioKbps)}<small> kb/s</small></strong></div><div><span>VIDEO RATE</span><strong>{metrics.videoKbps === undefined ? '—' : (metrics.videoKbps / 1000).toFixed(1)}<small> Mb/s</small></strong></div><div><span>VIDEO OUTPUT</span><strong className="resolution-metric">{metrics.width && metrics.height ? `${metrics.width}×${metrics.height}` : '—'}<small>{metrics.fps ? ` · ${Math.round(metrics.fps)} fps` : ''}</small></strong></div><div><span>MEDIA RECEIVED</span><strong data-testid="received-bytes">{metrics.received}<small> B</small></strong></div></section><p className="metrics-note">{metrics.quality || 'Automatic bandwidth management'} · {metrics.route || 'Media route pending'} · {metrics.freezes || 0} video freezes · Network RTT is not end-to-end playback latency. Quality can decrease during congestion.</p>
        <details className="activity"><summary>Audio route diagnostics</summary><p>Mic: {micState} · {metrics.capture?.sampleRate || '—'} Hz / {metrics.capture?.channelCount || '—'} channel · Received samples: {metrics.audioSamples || 0} · Concealed samples: {metrics.concealedSamples || 0}</p>{metrics.audio?.map((a, i) => <p key={`stats-${i}`} data-testid="audio-source-diagnostic" data-direction={a.direction} data-source={a.source} data-timestamp={a.timestamp} data-bytes={a.bytes} data-samples={a.samples} data-energy={a.energy} data-concealed={a.concealed} data-jitter-buffer-ms={a.jitterBufferMs}>{a.direction === 'send' ? 'Sending' : 'Receiving'} {a.source} · {a.bytes} B · {a.samples} samples · {a.concealed} concealed · {a.jitterBufferMs.toFixed(1)} ms jitter buffer</p>)}{metrics.playback?.map((p, i) => <p key={i}>{peers.find(peer => peer.id === p.peerId)?.name || p.peerId} · {p.source} · {p.muted ? 'muted by listening policy' : p.paused ? 'playback paused / blocked' : 'playing'} · volume {Math.round(p.volume * 100)}% · output {p.sink}</p>)}</details>
        <details className="activity"><summary>Room activity <span>{activity.length ? `${activity.length} events` : 'No activity yet'}</span></summary><div role="log" aria-live="polite">{activity.length ? activity.map((item, i) => <p key={i}><time>{item.time}</time>{item.message}</p>) : <p>Connection and sharing updates will appear here.</p>}</div></details>
</>;
  const settingsLabel = { devices: 'Devices and listening', audio: 'Share device audio', screens: 'Share your screen', diagnostics: 'Connection diagnostics', connection: 'Server connection', sounds: 'Interface sounds', rooms: 'Room management' };
  return <div className={`shell room-shell ${inRoom ? 'joined' : 'connection-only'}`}>
    <header className="topbar"><a className="brand" href="#" aria-label="AudioShare home"><span className="brand-mark"><Icon kind="sound" size={24}/></span>audio<span>share</span><span className="build-tag">v0.2.3 · LIVE ROOM</span></a><div className="appearance-controls"><button className="sound-toggle" type="button" role="switch" aria-label="Notification sounds" aria-checked={soundsEnabled} onClick={() => { setSoundsEnabled(value => !value); if (!soundsEnabled) { notificationSounds.current ??= new NotificationSounds(); void notificationSounds.current.unlock(); } }}><Icon kind="sound" size={16}/><span>Sounds {soundsEnabled ? 'on' : 'off'}</span></button><ThemeToggle/></div><div className="platform"><span className="tiny-dot"/>{desktop ? 'Windows desktop' : 'Browser client'}</div></header>

    <main>
      {!inRoom && <div className="page-heading"><div><div className="eyebrow">SOUND CLEAR. STAY TOGETHER.</div><h1>Your sound. Your screen<span>.</span></h1><p>Share what’s playing, show what’s happening, and stay in the room.</p></div><ConnectionStatus state={status}/></div>}
      {error && !panel && <div className="alert" role="alert"><span>{error}</span><button className="text-button" onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
      {status === 'reconnecting' && <div className="connection-notice" role="status">Connection interrupted. Reconnecting automatically. Your room and draft stay here.</div>}
      {blocked && <div className="alert playback">Incoming audio is paused.<button className="text-button" onClick={() => { const client = room.current; void client?.resumePlayback().catch(() => { if (room.current === client) setError('Playback is still blocked. Try joining again.'); }); }}>Enable listening <Icon kind="arrow" size={16}/></button></div>}
      {!inRoom && <div className="workspace meeting-workspace"><aside className="meeting-sidebar">{connectionPanel}</aside></div>}
      {inRoom && <>
        <div className="meeting-heading"><div><span className="section-label">LIVE ROOM</span><h1>{roomName}</h1>{selfRole && <span className="room-role">{selfRole}</span>}</div><ConnectionStatus state={status} elapsed={elapsed}/></div>
        <div className={'meeting-canvas-layout' + (chatOpen ? ' chat-is-open' : '') + (peopleOpen ? ' people-is-open' : '')}>
          <div className="meeting-canvas"><MeetingStage name={name} microphone={microphone} peers={peers} videos={videos} camera={cameraPreview} screen={preview} receiveVideo={receiveVideo} sharing={sharing} localAudioLevel={level}
            sourceVolumes={sourceVolumes} volumes={volumes} audioActivity={metrics.playback} audioMetrics={metrics.audio}
            onVolume={(id, value) => { room.current?.volume(id, value); setVolumes(old => ({ ...old, [id]: value })); }}
            onSourceVolume={(id, source, value) => { room.current?.volumeSource(id, source, value); setSourceVolumes(old => ({ ...old, [`${id}:${source}`]: value })); }}
            onQuality={(id, height) => { try { room.current?.receiveQuality(id, height); } catch (error) { setError(message(error)); } }}/></div>
          <motion.aside className="inline-drawer people-drawer" aria-hidden={!peopleOpen} inert={!peopleOpen} animate={{ opacity: peopleOpen ? 1 : 0 }} transition={{ duration: reducedMotion ? 0 : .18 }} onKeyDown={event => { if (event.key === 'Escape') closePeople(); }}>
            <div className="drawer-heading"><h2>Participants</h2><button ref={peopleCloseButton} className="drawer-close" type="button" onClick={closePeople} aria-label="Close participants">×</button></div>
            <p className="drawer-description">Live attendance · room access is managed separately.</p>
        <section className="card room-panel"><div className="room-heading"><div><span className="section-label">THE ROOM</span><h2>{roomName}</h2></div><span className="count-badge">{inRoom ? peers.length + 1 : 0} online</span></div>
          {!inRoom ? <div className="empty-room"><span className="empty-icon"><Icon kind="headphones" size={28}/></span><div><h3>Your room is waiting.</h3><p>Connect to a server to see who’s here.</p></div></div> : <div className="participant-list"><div className="participant self"><span className="avatar">{name.slice(0, 1).toUpperCase()}</span><div className="person"><strong>{name} <span>{selfRole ? `you · ${selfRole}` : accessSession?.owner ? 'you · owner' : 'you'}</span></strong><small>{sharing ? 'Sharing audio' : microphone ? 'Voice on' : 'Listening'}{videoSharing ? ' · sharing screen' : ''}{cameraPreview ? ' · camera on' : ''}</small></div><span className={`person-state ${sharing || videoSharing ? 'broadcasting' : ''}`}><span className="tiny-dot"/>{sharing || videoSharing ? 'Sharing' : 'Connected'}</span></div>{peers.map(peer => <div className="participant" key={peer.id} data-testid="peer"><span className="avatar guest">{peer.name.slice(0, 1).toUpperCase()}</span><div className="person"><strong>{peer.name}</strong>{peer.role && <span className="room-role">{peer.role}</span>}<small>{peer.streaming ? 'Sharing audio' : peer.microphone ? 'Voice on' : 'Listening'}{peer.speaking ? ' · speaking' : ''}{peer.videoStreaming ? ' · sharing screen' : ''}{peer.cameraStreaming ? ' · camera on' : ''} · {states[peer.id] || 'connected'}</small></div><div className="source-volumes">{(['microphone', 'screen_share_audio'] as const).map(source => <label key={source}><span>{source === 'microphone' ? 'Voice' : 'Shared audio'}</span><input aria-label={`${peer.name} ${source === 'microphone' ? 'voice' : 'shared audio'} volume`} type="range" min="0" max="1" step="0.01" value={sourceVolumes[`${peer.id}:${source}`] ?? 1} onChange={event => { const value = Number(event.target.value); room.current?.volumeSource(peer.id, source, value); setSourceVolumes(old => ({ ...old, [`${peer.id}:${source}`]: value })); }}/></label>)}</div><label className="volume"><span className="sr-only">{peer.name} volume</span><Icon kind="sound" size={15}/><input type="range" min="0" max="1" step="0.01" value={volumes[peer.id] ?? 1} onChange={event => { const value = Number(event.target.value); room.current?.volume(peer.id, value); setVolumes(old => ({ ...old, [peer.id]: value })); }}/></label><span className={`person-state ${peer.streaming || peer.videoStreaming ? 'broadcasting' : ''}`}><span className="tiny-dot"/>{peer.streaming || peer.videoStreaming ? 'Sharing' : 'Connected'}</span></div>)}{!peers.length && <p className="invite"><Icon kind="plus" size={15}/>Invite someone to {host}:{port} · {roomName}.</p>}</div>}<div className="room-bottom"><span>{streams} active {streams === 1 ? 'sharer' : 'sharers'}</span><span>Adaptive WebRTC · encrypted media</span></div>
        </section>

          </motion.aside>
          <motion.aside className="inline-drawer chat-drawer" aria-hidden={!chatOpen} inert={!chatOpen} animate={{ opacity: chatOpen ? 1 : 0 }} transition={{ duration: reducedMotion ? 0 : .18 }}>
        <section className="card conversation-panel meeting-chat" id="meeting-chat" onKeyDown={event => { if (event.key === 'Escape') closeChat(); }} aria-labelledby="conversation-heading">
          <div className="room-heading"><h2 id="conversation-heading">Room chat</h2><button className="meeting-close-chat" type="button" onClick={closeChat} aria-label="Close chat">×</button></div>
          <div className="chat-log" ref={chatLog} onScroll={event => { const element = event.currentTarget; chatAtBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48; if (chatAtBottom.current) setChatJump(false); }} role="log" aria-label="Room messages" aria-live="polite" aria-relevant="additions text">{chat.length ? chat.map(item => <article className={`chat-message ${item.local ? 'own-message' : ''}`} key={`${item.peerId}:${item.id}`}><div className="chat-meta"><strong>{item.name}{item.local ? ' (you)' : ''}</strong><time>{new Date(item.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>{item.text}</p></article>) : <p className="chat-empty">{inRoom ? 'Say hello to the room.' : 'Connect to send messages and talk.'}</p>}</div>
          {chatJump && <button type="button" className="chat-jump" onClick={jumpToLatest}>New messages ↓</button>}
          <form className="chat-composer" onSubmit={sendMessage}><div><label htmlFor="chat-message">Message</label><textarea ref={chatInput} id="chat-message" value={draft} onChange={event => { setDraft(event.target.value); setChatFailure(''); }} onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            if (!event.repeat && !chatPending.current) event.currentTarget.form?.requestSubmit();
          }} maxLength={2000} rows={2} disabled={!connected} readOnly={chatBusy} placeholder="Write to everyone in this room…" aria-describedby="chat-note"/></div><button type="submit" className="button primary" disabled={!connected || chatBusy || !draft.trim()} aria-busy={chatBusy}>{chatBusy ? 'Sending…' : chatFailure && pendingChatPayload.current?.text === draft.trim() ? 'Retry message' : 'Send message'}</button></form>
          {chatFailure && <p className="chat-failure" role="alert">{chatFailure}</p>}
          <p id="chat-note" className="field-hint">Live messages only · up to 2,000 characters · latest 200 shown. Messages are not saved or queued while offline.</p>
        </section>

          </motion.aside>
        </div>
        <div className="action-dock meeting-dock" aria-label="Room controls">
          <div className="meeting-actions media-actions">
            <div className="split-control"><ControlHint text="Microphone on/off · Ctrl+Shift+M"><button type="button" className="meeting-control" aria-label={microphoneDesired ? 'Turn off microphone' : 'Turn on microphone'} aria-pressed={microphone} aria-busy={microphoneBusy} disabled={!microphoneDesired && (!connected || !publishAllowed || !canCapture)} onClick={() => { void toggleMicrophone(); }}><Icon kind="mic"/><span>{({off:'Mic off',starting:'Cancel mic',live:'Mic on',reconnecting:'Mic reconnecting',unavailable:'Mic unavailable'})[micState]}</span></button></ControlHint><button type="button" className="control-options" aria-label="Microphone settings" onClick={event => showPanel('devices', event.currentTarget)}>⌃</button></div>
            <div className="split-control"><ControlHint text="Camera on/off · Ctrl+Shift+V"><button type="button" className="meeting-control" aria-label={cameraDesired || cameraPreview || cameraBusy ? 'Turn off camera' : 'Turn on camera'} aria-pressed={Boolean(cameraPreview)} aria-busy={cameraBusy} disabled={!cameraDesired && !cameraPreview && !cameraBusy && (!connected || !shareAllowed || !canCapture)} onClick={() => { void toggleCamera(); }}><Icon kind="camera"/><span>{({off:'Camera off',starting:'Cancel camera',live:'Camera on',reconnecting:'Camera reconnecting',unavailable:'Camera unavailable'})[cameraState]}</span></button></ControlHint><button type="button" className="control-options" aria-label="Camera settings" onClick={event => showPanel('devices', event.currentTarget)}>⌃</button></div>
            <ControlHint text="Share a screen or window"><button type="button" className="meeting-control" aria-label={videoSharing || videoBusy ? 'Stop sharing screen' : 'Share screen'} aria-pressed={videoSharing} aria-busy={videoBusy} disabled={!videoSharing && !videoBusy && (!connected || !shareAllowed || !canCapture)} onClick={event => { if (videoSharing || videoBusy) void stopVideo(); else showPanel('screens', event.currentTarget); }}><Icon kind="screen"/><span>{videoBusy ? 'Cancel screen' : videoSharing ? 'Stop screen' : 'Share screen'}</span></button></ControlHint>
            <ControlHint text="Share device sound independently of your microphone"><button type="button" className="meeting-control" aria-label={sharing || audioBusy ? 'Stop sharing audio' : 'Share device audio'} aria-pressed={sharing} aria-busy={audioBusy} disabled={!sharing && !audioBusy && (!connected || !shareAllowed || !canCapture)} onClick={event => { if (sharing || audioBusy) void stopAudio(); else showPanel('audio', event.currentTarget); }}><Icon kind="sound"/><span>{audioBusy ? 'Cancel audio' : sharing ? 'Stop audio' : 'Device audio'}</span></button></ControlHint>
            <div className="split-control"><ControlHint text="Deafen incoming audio · Ctrl+Shift+D"><button type="button" className="meeting-control" aria-label={deafened ? 'Undeafen' : 'Deafen'} aria-pressed={deafened} onClick={() => setDeafened(value => !value)}><Icon kind="headphones"/><span>{deafened ? 'Deafened' : 'Listening'}</span></button></ControlHint><button type="button" className="control-options" aria-label="Playback settings" onClick={event => showPanel('devices', event.currentTarget)}>⌃</button></div>
          </div>
          <div className="meeting-actions collaboration-actions">
            <ControlHint text="Room chat · Ctrl+Shift+C"><button ref={chatButton} type="button" className="meeting-control" aria-label="Chat" aria-expanded={chatOpen} aria-controls="meeting-chat" onClick={openChat}><Icon kind="chat"/><span>Chat{unread > 0 && <span className="meeting-unread">{unread > 99 ? '99+' : unread}</span>}</span></button></ControlHint>
            <div ref={moreControls} className={'secondary-controls' + (moreOpen ? ' more-is-open' : '')}>
              <button type="button" className="meeting-control compact-chat-control" aria-label="Room chat" aria-expanded={chatOpen} onClick={openChat}><Icon kind="chat"/><span>Chat{unread > 0 ? ` (${unread})` : ''}</span></button>
              <ControlHint text="Live participants"><button ref={peopleButton} type="button" className="meeting-control" aria-label="Participants" aria-expanded={peopleOpen} onClick={togglePeople}><Icon kind="headphones"/><span>People {peers.length + 1}</span></button></ControlHint>
              {accessSession && <ControlHint text="Manage room access and invitations"><button type="button" className="meeting-control" onClick={event => showPanel('rooms', event.currentTarget)}><Icon kind="server"/><span>Rooms</span></button></ControlHint>}
              <ControlHint text="Devices, sharing quality, sounds and connection"><button type="button" className="meeting-control" aria-haspopup="dialog" onClick={event => showPanel('devices', event.currentTarget)}><Icon kind="plus"/><span>Settings</span></button></ControlHint>
            </div>
            <button ref={moreButton} className="meeting-control more-control" type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen(value => !value)}><span aria-hidden="true">•••</span><span>More</span></button>
          </div>
          <div className="meeting-exit"><ControlHint text="Leave room and stop all sharing"><button type="button" className="meeting-control leave" aria-label="Disconnect" onClick={disconnect}><Icon kind="leave"/><span>Leave</span></button></ControlHint></div>
        </div>
      </>}
      <MeetingDialog open={Boolean(panel)} onOpenChange={open => { if (!open) setPanel(null); }} title={panel ? settingsLabel[panel] : 'Meeting settings'} description="Changes apply to your current meeting. Requested quality may differ from measured delivery." returnFocus={panelTrigger}>
        {panel !== 'rooms' && <nav className="settings-sections" aria-label="Settings sections">{(['devices','audio','screens','sounds','diagnostics','connection'] as const).map(id => <button type="button" key={id} aria-pressed={panel === id} onClick={() => setPanel(id)}>{({devices:'Devices',audio:'Device audio',screens:'Screen',sounds:'Sounds',diagnostics:'Diagnostics',connection:'Server'})[id]}</button>)}</nav>}
        {error && <div className="alert" role="alert"><span>{error}</span><button className="text-button" onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
        {panel === 'devices' && deviceSettings}{panel === 'audio' && audioSettings}{panel === 'screens' && screenSettings}{panel === 'diagnostics' && connectionDiagnostics}{panel === 'connection' && connectionPanel}
        {panel === 'rooms' && accessSession && <>        <div><RoomManager key={accessSession?.identity || 'shared-access'} base={accessBase.current || `${secure ? 'https' : 'http'}://${host}:${port}`} session={accessSession} active={inRoom && panel === 'rooms'} liveRoom={connected ? roomName.trim() : undefined} livePeerIds={peers.map(peer => peer.id)} onSelect={next => { disconnect(); setRoomName(next); setPanel(null); }} onLogout={() => { disconnect(); setAccessSession(null); }}/></div>
</>}
        {panel === 'sounds' && <section className="sound-settings"><h3>Interface sounds</h3><label className="check"><input type="checkbox" checked={soundsEnabled} onChange={event => { setSoundsEnabled(event.target.checked); if (event.target.checked) { notificationSounds.current ??= new NotificationSounds(); void notificationSounds.current.unlock(); } }}/>Enable interface sounds</label><label htmlFor="interface-volume">Notification volume · {Math.round(soundVolume * 100)}%</label><input id="interface-volume" type="range" min="0" max="1" step=".05" value={soundVolume} onChange={event => setSoundVolume(Number(event.target.value))}/><p className="field-hint">Subtle cues for participants, chat, connection changes and action failures. Sounds stay silent while your microphone, camera, screen or device audio is sending or starting, so they cannot enter your share.</p><details className="event-sound-options"><summary>Event sounds</summary>{([['peerJoined','Participant joins'],['peerLeft','Participant leaves'],['message','Incoming chat'],['sharingStarted','Sharing starts'],['sharingStopped','Sharing stops'],['connectionLost','Connection lost'],['connectionRestored','Connection restored'],['failure','Action failure']] as const).map(([event,label]) => <label className="check" key={event}><input type="checkbox" checked={soundEvents[event] !== false} onChange={change => setSoundEvents(old => ({ ...old, [event]: change.target.checked }))}/>{label}</label>)}</details><p className="field-hint">Original synthesized tones. No external audio files.</p></section>}
      </MeetingDialog>
    </main>
  </div>;
}
