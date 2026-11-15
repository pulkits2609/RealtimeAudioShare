import { Room as MediaRoom, RoomEvent, ConnectionState, Track, LocalAudioTrack, LocalVideoTrack, RemoteAudioTrack, RemoteVideoTrack, TrackEvent, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication, type LocalTrack } from 'livekit-client';
import { audioBitrate, audioPublishOptions, cappedDimensions, VIDEO_PROFILES, videoPublishOptions, type AudioQuality, type VideoQuality, type VideoFps, type SharingMode } from './quality';
import { VideoQuality as SubscriptionQuality, DisconnectReason } from 'livekit-client';
import type { Peer, RemoteVideo } from './types';
import { CHAT_TOPIC, ChatGuard, chatPayload, type ChatMessage, type ChatPayload } from './chat';
import { sourceOwner } from './source-owner';
export type { ChatMessage } from './chat';

export type MicrophoneState = 'off' | 'starting' | 'live' | 'reconnecting' | 'unavailable';
export type CameraState = 'off' | 'starting' | 'live' | 'reconnecting' | 'unavailable';

/** Display-only role from managed server metadata; authorization remains server-side. */
function managedRole(metadata?: string): Peer['role'] {
  try {
    const value = JSON.parse(metadata || '{}');
    if (value?.managed === true && ['owner', 'moderator', 'participant', 'viewer'].includes(value.role)) return value.role;
  } catch { /* Unrecognized metadata never supplies a role. */ }
}
export interface PlaybackDiagnostic { peerId: string; source: string; muted: boolean; paused: boolean; volume: number; sink: string; }
export interface AudioDiagnostic { direction: 'send' | 'receive'; source: string; peerId?: string; timestamp: number; bytes: number; packets: number; samples: number; energy: number; concealed: number; jitterBufferMs: number; }
export interface Metrics {
  rtt: number | null; jitter: number | null; loss: number; received: number; sent: number; connected: number;
  route?: string; freezes?: number;
  captureDelivery?: { delivered: number; dropped: number; pending: number; capacity: number };
  audio?: AudioDiagnostic[]; captureExcludesSelf?: boolean; playback?: PlaybackDiagnostic[]; audioSamples?: number; audioEnergy?: number; capture?: { sampleRate?: number; channelCount?: number; deviceId?: string }; audioKbps?: number; videoKbps?: number; fps?: number; width?: number; height?: number; quality?: string; concealedSamples?: number;
}
interface Callbacks {
  peers(peers: Peer[], selfId: string): void;
  status(status: 'connecting' | 'connected' | 'reconnecting' | 'offline'): void;
  activity(message: string): void;
  error(message: string): void;
  playbackBlocked(blocked: boolean): void;
  transport(peerId: string, state: string): void;
  videos?(videos: RemoteVideo[]): void;
  chat?(message: ChatMessage): void;
  camera?(stream: MediaStream | null): void;
  cameraState?(state: CameraState, desired: boolean): void;
  microphone?(enabled: boolean): void;
  microphoneState?(state: MicrophoneState, desired: boolean): void;
  output?(id: string): void;
  lobby?(lobby: { groupId: number; channelId: number; serverInstance: string }): void;
  permissions?(permissions: { canPublish: boolean; canShare: boolean; role?: string }): void;
}

/** All Internet media is handled by LiveKit/libwebrtc: RTP timing, recovery,
 * congestion control, adaptive jitter buffers and synchronized A/V playback. */
export class Room {
  private media?: MediaRoom;
  private abort?: AbortController;
  private closed = false;
  private audios = new Map<string, { track: RemoteAudioTrack; element: HTMLAudioElement; peerId: string; publisherId?: string; source: Track.Source }>();
  private videos = new Map<string, RemoteVideo>();
  private volumes = new Map<string, number>();
  private sink = '';
  private sourceSinks = new Map<string, string>();
  private muted = false;
  private sharingAudio = false;
  private captureExcludesSelf = false;
  private defaultInputGroup?: string;
  private listenVoice = false;
  private listenShared = false;
  private videoEnabled = true;
  private audioTrack?: LocalAudioTrack;
  private videoTrack?: LocalVideoTrack;
  private cameraCapture?: { track: LocalVideoTrack; stream: MediaStream };
  private cameraGeneration = 0;
  private cameraDevice = 'default';
  private cameraDesired = false;
  private cameraStarting = false;
  private cameraRecoveryNotice = '';
  private microphoneDesired = false;
  private microphoneDevice = 'default';
  private microphoneGeneration = 0;
  private microphoneStarting = false;
  private microphoneTrack?: LocalAudioTrack;
  private chatGuard = new ChatGuard();
  private chatSending = false;
  private chatSent: number[] = [];
  private chatAttempts = new Map<string, { payload: ChatPayload; sent: boolean }>();
  private audioQuality: AudioQuality = 'adaptive';
  private videoQuality: VideoQuality = 'auto';
  private videoFps: VideoFps = 30;
  private sharingMode: SharingMode = 'motion';
  private sourceVolumes = new Map<string, number>();
  private connectionQuality = 'excellent';
  private audioQueue = Promise.resolve();
  private videoQueue = Promise.resolve();
  private lastSample?: { time: number; audio: number; video: number };
  private controllerTimer?: ReturnType<typeof setInterval>;
  private goodSamples = 0;
  private degraded = false;
  private controllerBusy = false;
  constructor(private cb: Callbacks) {}

  async connect(url: string, name: string, token: string, roomName = 'lobby', accessToken?: string): Promise<void> {
    if (this.media || this.closed) throw new Error('Create a new connection after disconnecting.');
    const base = new URL(url); const api = new URL(base);
    api.protocol = base.protocol === 'wss:' || base.protocol === 'https:' ? 'https:' : 'http:';
    api.pathname = '/v1/session'; api.search = ''; api.hash = '';
    this.abort = new AbortController();
    const timeout = setTimeout(() => this.abort?.abort(new Error('Connection API timed out. Check the public HTTPS port, forwarding and server readiness.')), 15000);
    const media = new MediaRoom({ adaptiveStream: { pixelDensity: 1 }, dynacast: true,
      disconnectOnPageLeave: true, stopLocalTrackOnUnpublish: false,
      publishDefaults: { dtx: false, red: true, forceStereo: true, videoCodec: 'vp8' },
    });
    this.media = media; this.cb.status('connecting'); this.bindEvents(media);
    try {
      const response = await fetch(api, { method: 'POST', redirect: 'error', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) }, body: JSON.stringify({ name, room: roomName, token }), signal: this.abort.signal });
      let data: { token?: string; url?: string; error?: string; permissions?: { canPublish: boolean; canShare?: boolean }; role?: string; voiceLobby?: { groupId: number; channelId: number; serverInstance: string } };
      try { data = await response.json(); } catch { throw new Error('The server is running an older build or returned an invalid response. Restart the upgraded server.'); }
      if (!response.ok) throw new Error(data.error || `Server rejected the connection (${response.status}).`);
      if (typeof data.token !== 'string' || typeof data.url !== 'string') throw new Error('Server response is missing its media connection details.');
      if (this.closed) return;
      if (data.voiceLobby) this.cb.lobby?.(data.voiceLobby);
      this.cb.permissions?.({ canPublish: data.permissions?.canPublish ?? true, canShare: data.permissions?.canShare ?? data.permissions?.canPublish ?? true, role: data.role });
      const mediaUrl = new URL(data.url, base); mediaUrl.protocol = ['https:', 'wss:'].includes(mediaUrl.protocol) ? 'wss:' : 'ws:';
      if ((api.protocol === 'https:' || location.protocol === 'https:') && mediaUrl.protocol !== 'wss:') throw new Error('HTTPS clients require a secure WSS media server. Check server TLS configuration.');
      await media.connect(mediaUrl.href, data.token, { autoSubscribe: true, maxRetries: 2, websocketTimeout: 15000,
        peerConnectionTimeout: 20000, subscriberAllowPause: true });
      if (this.closed) { await media.disconnect(false); return; }
      this.cb.status('connected'); this.cb.activity('Connected. Adaptive audio and video are ready.'); this.publishPeers();
      this.controllerTimer = setInterval(() => { void this.adaptAudio().catch(() => {}); }, 4000);
      if (this.sink) await this.output(this.sink);
      await media.startAudio().catch(() => this.cb.playbackBlocked(true));
    } catch (error) {
      if (!this.closed) {
        const message = error instanceof Error ? error.message : String(error);
        this.cb.error(message.includes('Failed to fetch') ? 'Cannot reach the connection API. Check address, TLS, allowed origins and that the upgraded server is running.' : message);
        this.close(); throw error;
      }
    } finally { clearTimeout(timeout); }
  }
  private bindEvents(media: MediaRoom) {
    media.on(RoomEvent.ActiveSpeakersChanged, () => this.publishPeers());
    media.on(RoomEvent.DataReceived, (bytes, participant, _kind, topic) => {
      if (topic !== CHAT_TOPIC || !participant || bytes.byteLength > 10000 || this.closed) return;
      try {
        const payload = chatPayload(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
        if (payload && this.chatGuard.accept(participant.identity, payload)) this.cb.chat?.({ ...payload, peerId: participant.identity, name: participant.name || participant.identity, local: false });
      } catch { /* Invalid data from another participant is discarded. */ }
    });
    media.on(RoomEvent.LocalTrackPublished, publication => {
      if (publication.source === Track.Source.Camera) {
        if (!this.cameraDesired || this.closed || publication.track !== this.cameraCapture?.track) {
          publication.track?.stop(); if (publication.track) void media.localParticipant.unpublishTrack(publication.track, true).catch(() => {});
        }
        this.reportCamera();
        return;
      }
      if (publication.source !== Track.Source.Microphone) return;
      if (!this.microphoneDesired || this.closed || publication.track !== this.microphoneTrack) {
        publication.track?.stop(); if (publication.track) void media.localParticipant.unpublishTrack(publication.track, true).catch(() => {});
      }
      this.reportMicrophone();
    });
    media.on(RoomEvent.LocalTrackUnpublished, publication => {
      if (publication.source === Track.Source.Microphone) this.reportMicrophone();
      if (publication.source === Track.Source.Camera && this.cameraCapture && publication.track === this.cameraCapture.track && media.state === ConnectionState.Connected) {
        this.cameraGeneration++; this.cameraStarting = false; this.stopCameraCapture(); this.reportCamera();
      }
    });
    media.on(RoomEvent.ActiveDeviceChanged, (kind, id) => { if (kind === 'audiooutput') { this.sink = id === 'default' ? '' : id; this.cb.output?.(this.sink); } });
    media.on(RoomEvent.ParticipantConnected, participant => { this.cb.activity(`${participant.name || participant.identity} joined.`); this.publishPeers(); });
    media.on(RoomEvent.ParticipantDisconnected, participant => {
      this.cb.activity(`${participant.name || participant.identity} left.`);
      this.volumes.delete(participant.identity);
      for (const key of this.sourceVolumes.keys()) if (key.startsWith(`${participant.identity}:`)) this.sourceVolumes.delete(key);
      for (const [id, audio] of this.audios) if (audio.peerId === participant.identity || audio.publisherId === participant.identity) this.dropRemote(id);
      for (const [id, video] of this.videos) if (video.peerId === participant.identity || video.publisherId === participant.identity) this.dropRemote(id);
      this.publishPeers();
    });
    media.on(RoomEvent.TrackSubscribed, (track, publication, participant) => this.subscribe(track, publication, participant));
    media.on(RoomEvent.TrackUnsubscribed, (_track, publication) => this.dropRemote(publication.trackSid));
    media.on(RoomEvent.TrackPublished, (publication, participant) => {
      if (publication.kind === Track.Kind.Video && !this.videoEnabled) publication.setSubscribed(false);
      this.publishPeers(); this.cb.activity(`${participant.name || participant.identity} started sharing ${publication.kind}.`);
    });
    media.on(RoomEvent.TrackUnpublished, publication => {
      this.dropRemote(publication.trackSid);
      this.publishPeers();
    });
    for (const event of [RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.ParticipantNameChanged, RoomEvent.ParticipantMetadataChanged] as const) media.on(event, () => this.publishPeers());
    media.on(RoomEvent.AudioPlaybackStatusChanged, playing => this.cb.playbackBlocked(!playing));
    media.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (participant.isLocal) { this.connectionQuality = quality; void this.adaptAudio().catch(() => {}); }
      else this.cb.transport(participant.identity, quality);
    });
    media.on(RoomEvent.TrackStreamStateChanged, (_publication, state, participant) => {
      this.cb.transport(participant.identity, state === Track.StreamState.Paused ? 'video paused for bandwidth' : 'streaming');
    });
    const recovering = () => { if (!this.closed) { this.cb.status('reconnecting'); this.reportMicrophone(); this.reportCamera(); this.cb.activity('Network interrupted. Reconnecting automatically; capture remains active.'); } };
    media.on(RoomEvent.Reconnecting, recovering); media.on(RoomEvent.SignalReconnecting, recovering);
    media.on(RoomEvent.Reconnected, () => {
      if (this.closed) return;
      this.cb.status('connected'); this.cb.activity('Connection restored.'); this.publishPeers(); this.reportMicrophone(); this.reportCamera();
      if (this.microphoneDesired && !this.microphoneTrack && !this.microphoneStarting) void this.startMicrophone(false).catch(error => this.cb.error(String(error)));
      if (this.cameraDesired) void this.recoverDevices().catch(error => this.cb.error(String(error)));
      void this.output(this.sink).catch(() => this.output('').catch(() => this.cb.error('Playback output unavailable. Choose a device.')));
    });
    media.on(RoomEvent.TrackSubscriptionFailed, () => this.cb.error('A media subscription failed. Check the server media ports and TURN/TLS fallback.'));
    media.on(RoomEvent.Disconnected, reason => {
      if (!this.closed) {
        const message = reason === DisconnectReason.PARTICIPANT_REMOVED ? 'Your session was removed or its permissions changed. Check room access before rejoining.'
          : reason === DisconnectReason.ROOM_DELETED ? 'The room was closed by its owner.'
          : reason === DisconnectReason.DUPLICATE_IDENTITY ? 'This identity connected from another client. Only one active connection is allowed for this session.'
          : 'Connection ended after recovery attempts. Rejoin to reconnect.';
        this.cb.error(message); this.close();
      }
    });
  }
  private publishPeers() {
    if (!this.media || this.closed) return;
    const peers = new Map<string, Peer>();
    for (const participant of this.media.remoteParticipants.values()) {
      const owner = sourceOwner(participant.identity, participant.name || participant.identity, participant.metadata);
      if (owner.identity === this.media.localParticipant.identity || (owner.companion && !this.media.remoteParticipants.has(owner.identity))) continue;
      const previous = peers.get(owner.identity);
      peers.set(owner.identity, { id: owner.identity, name: previous && owner.companion ? previous.name : owner.name,
        role: owner.companion ? previous?.role : managedRole(participant.metadata),
        speaking: Boolean(previous?.speaking || participant.isSpeaking),
        microphone: Boolean(previous?.microphone || [...participant.audioTrackPublications.values()].some(track => track.source === Track.Source.Microphone && !track.isMuted)),
        streaming: Boolean(previous?.streaming || [...participant.audioTrackPublications.values()].some(track => track.source === Track.Source.ScreenShareAudio && !track.isMuted)),
        videoStreaming: Boolean(previous?.videoStreaming || [...participant.videoTrackPublications.values()].some(track => track.source === Track.Source.ScreenShare && !track.isMuted)),
        cameraStreaming: Boolean(previous?.cameraStreaming || [...participant.videoTrackPublications.values()].some(track => track.source === Track.Source.Camera && !track.isMuted)) });
    }
    this.cb.peers([...peers.values()], this.media.localParticipant.identity);
  }
  private subscribe(track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) {
    if (this.closed) return;
    const owner = sourceOwner(participant.identity, participant.name || participant.identity, participant.metadata);
    if (owner.companion && owner.identity === this.media?.localParticipant.identity) { publication.setSubscribed(false); return; }
    this.dropRemote(publication.trackSid);
    if (track instanceof RemoteAudioTrack) {
      const element = document.createElement('audio'); element.autoplay = true; element.dataset.peerId = owner.identity;
      document.body.appendChild(element); track.attach(element); element.muted = this.playbackMuted(publication.source);
      element.dataset.source = publication.source;
      track.setVolume(this.sourceVolumes.get(`${owner.identity}:${publication.source}`) ?? this.volumes.get(owner.identity) ?? 1);
      this.audios.set(publication.trackSid, { track, element, peerId: owner.identity, publisherId: participant.identity, source: publication.source });
      const sink = this.sourceSinks.get(publication.source) || this.sink;
      if (sink) void track.setSinkId(sink).catch(() => this.cb.error('Selected playback output is unavailable. Choose another device.'));
      void element.play().catch(() => this.cb.playbackBlocked(true));
    } else if (track instanceof RemoteVideoTrack) {
      if (!this.videoEnabled) { publication.setSubscribed(false); return; }
      this.videos.set(publication.trackSid, { source: publication.source === Track.Source.Camera ? 'camera' : 'screen_share', id: publication.trackSid, peerId: owner.identity, publisherId: participant.identity, name: owner.name, track, width: publication.dimensions?.width, height: publication.dimensions?.height, layers: publication.trackInfo?.layers.map(layer => layer.height) });
      this.cb.videos?.([...this.videos.values()]);
    }
    this.publishPeers();
  }
  private dropRemote(id: string) {
    const audio = this.audios.get(id);
    if (audio) { audio.track.detach(audio.element); audio.element.pause(); audio.element.srcObject = null; audio.element.remove(); this.audios.delete(id); }
    const video = this.videos.get(id);
    if (video) { video.track.detach(); this.videos.delete(id); this.cb.videos?.([...this.videos.values()]); }
  }
  private requireMedia(): MediaRoom { if (!this.media || this.closed || this.media.state !== ConnectionState.Connected) throw new Error('Connect before changing media.'); return this.media; }
  async sendChat(text: string, messageId?: string): Promise<void> {
    const media = this.requireMedia(); const now = Date.now();
    const id = messageId ?? crypto.randomUUID();
    const previous = this.chatAttempts.get(id);
    if (previous && previous.payload.text !== text.trim()) throw new Error('A retry ID cannot be used for a different message.');
    const payload = chatPayload(previous?.payload ?? { id, text: text.trim(), sentAt: now });
    if (!payload) throw new Error('Write a message between 1 and 2000 characters without control characters.');
    if (previous?.sent) return;
    this.chatSent = this.chatSent.filter(time => now - time < 10000);
    if (this.chatSending || this.chatSent.length >= 5) throw new Error('Please wait before sending another message.');
    this.chatSending = true;
    const attempt = previous ?? { payload, sent: false };
    this.chatAttempts.set(id, attempt);
    if (this.chatAttempts.size > 200) this.chatAttempts.delete(this.chatAttempts.keys().next().value!);
    try {
      await media.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(payload)), { reliable: true, topic: CHAT_TOPIC });
      if (this.closed) return;
      attempt.sent = true;
      this.chatSent.push(now);
      this.cb.chat?.({ ...payload, peerId: media.localParticipant.identity, name: media.localParticipant.name || 'You', local: true });
    } finally { this.chatSending = false; }
  }
  private reportMicrophone() {
    const published = this.media?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    const live = this.microphoneDesired && Boolean(this.microphoneTrack && published === this.microphoneTrack && !this.microphoneTrack.isMuted && this.microphoneTrack.mediaStreamTrack.readyState === 'live');
    const state: MicrophoneState = !this.microphoneDesired ? 'off' : this.microphoneStarting ? 'starting' : this.media?.state !== ConnectionState.Connected ? 'reconnecting' : live ? 'live' : 'unavailable';
    this.cb.microphone?.(live); this.cb.microphoneState?.(state, this.microphoneDesired);
  }
  private stopMicrophoneCapture() {
    const track = this.microphoneTrack; this.microphoneTrack = undefined;
    track?.stop();
    const published = this.media?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (published && published !== track) published.stop();
    for (const stale of new Set([track, published])) if (stale) void this.media?.localParticipant.unpublishTrack(stale, true).catch(() => {});
  }
  setMicrophone(enabled: boolean): Promise<void> {
    if (!enabled) {
      this.microphoneDesired = false; this.microphoneGeneration++; this.microphoneStarting = false;
      void window.audioShareDesktop?.endMicrophoneSession?.().catch(() => {});
      this.stopMicrophoneCapture(); this.reportMicrophone();
      return Promise.resolve();
    }
    this.requireMedia();
    if (!window.isSecureContext) return Promise.reject(new Error('Microphone access requires HTTPS or the Windows application.'));
    if (this.microphoneDesired && (this.microphoneStarting || this.microphoneTrack?.mediaStreamTrack.readyState === 'live')) return Promise.resolve();
    this.microphoneDesired = true;
    return this.startMicrophone(true);
  }
  async microphoneInput(id: string): Promise<void> {
    this.microphoneDevice = id || 'default';
    if (!this.microphoneDesired) return;
    await this.startMicrophone(true);
  }
  private async startMicrophone(consent: boolean): Promise<void> {
    const media = this.media; if (!media || this.closed || !this.microphoneDesired) return;
    const generation = ++this.microphoneGeneration, device = this.microphoneDevice;
    const current = () => !this.closed && this.microphoneDesired && generation === this.microphoneGeneration;
    this.microphoneStarting = true; this.stopMicrophoneCapture(); this.reportMicrophone();
    let track: LocalAudioTrack | undefined, acquired: MediaStream | undefined;
    try {
      if (consent) await window.audioShareDesktop?.beginMicrophoneSession?.(device);
      if (!current()) return;
      const options = { deviceId: device === 'default' ? 'default' : { exact: device }, echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000 };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: options, video: false }); acquired = stream;
      if (!current()) { stream.getTracks().forEach(t => t.stop()); return; }
      const raw = stream.getAudioTracks()[0];
      if (!raw) { stream.getTracks().forEach(t => t.stop()); throw new Error('The microphone returned no audio track.'); }
      track = new LocalAudioTrack(raw, options, true); this.microphoneTrack = track;
      if (device !== 'default') {
        const actualDevice = raw.getSettings().deviceId;
        const available = (await navigator.mediaDevices.enumerateDevices()).some(d => d.kind === 'audioinput' && d.deviceId === device);
        if (!current() || !available || (actualDevice !== device)) {
          stream.getTracks().forEach(t => t.stop());
          if (current()) throw new Error('Selected microphone is unavailable. Choose another input or reconnect that device.');
          return;
        }
      }
      // Application owns capture/recovery. SDK owns transport republishing only.
      // userProvided prevents the SDK from silently changing a fixed mic to default.
      const owned = track;
      track.on(TrackEvent.Ended, () => {
        if (!current() || this.microphoneTrack !== owned) return;
        this.reportMicrophone();
        void this.recoverDevices().catch(error => this.cb.error(String(error)));
      });
      track.on(TrackEvent.Muted, () => this.reportMicrophone());
      track.on(TrackEvent.Unmuted, () => this.reportMicrophone());
      await media.localParticipant.publishTrack(track, { source: Track.Source.Microphone, forceStereo: false,
        audioPreset: { maxBitrate: 64000 }, dtx: true, red: true, name: 'Voice chat', stream: 'voice' });
      if (current() && device !== 'default') {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (current() && !devices.some(d => d.kind === 'audioinput' && d.deviceId === device)) {
          this.microphoneGeneration++; this.microphoneStarting = false; this.stopMicrophoneCapture(); this.reportMicrophone();
        }
      }
      if (!current()) { track.stop(); void media.localParticipant.unpublishTrack(track, true).catch(() => {}); }
    } catch (error) {
      track?.stop(); acquired?.getTracks().forEach(t => t.stop()); if (this.microphoneTrack === track) this.microphoneTrack = undefined;
      if (current()) throw error;
    } finally { if (current()) { this.microphoneStarting = false; this.reportMicrophone(); } }
  }
  async recoverDevices(): Promise<void> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    for (const [source, sink] of this.sourceSinks) if (sink && !devices.some(device => device.kind === 'audiooutput' && device.deviceId === sink)) {
      await this.outputSource(source as 'microphone' | 'screen_share_audio', '');
      this.cb.activity('A source playback device was removed. Following the main playback device.');
    }
    if (this.closed) return;
    if (this.sink && !devices.some(d => d.kind === 'audiooutput' && d.deviceId === this.sink)) {
      await this.output(''); this.cb.activity('Playback device removed. Using system default.');
    }
    const defaultGroup = devices.find(d => d.kind === 'audioinput' && d.deviceId === 'default')?.groupId;
    const defaultChanged = Boolean(this.defaultInputGroup && defaultGroup && this.defaultInputGroup !== defaultGroup);
    this.defaultInputGroup = defaultGroup;
    const microphoneRecovery = async () => {
      if (!this.microphoneDesired) return;
      const available = this.microphoneDevice === 'default' || devices.some(d => d.kind === 'audioinput' && d.deviceId === this.microphoneDevice);
      if (!available) { this.microphoneGeneration++; this.microphoneStarting = false; this.stopMicrophoneCapture(); this.reportMicrophone(); return; }
      if (this.microphoneStarting || this.media?.state !== ConnectionState.Connected) return;
      if (!this.microphoneTrack || this.microphoneTrack.mediaStreamTrack.readyState === 'ended' || (this.microphoneDevice === 'default' && defaultChanged)) await this.startMicrophone(false);
    };
    await Promise.all([microphoneRecovery(), this.recoverCamera(devices)]);
  }
  share(track: MediaStreamTrack | null): Promise<void> {
    const task = this.audioQueue.then(async () => {
      if (this.audioTrack) { await this.media?.localParticipant.unpublishTrack(this.audioTrack, false).catch(() => {}); this.audioTrack = undefined; }
      if (!track || this.closed) return;
      const media = this.requireMedia(); track.contentHint = 'music';
      const local = new LocalAudioTrack(track, { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 }, true);
      await media.localParticipant.publishTrack(local, { ...audioPublishOptions(this.audioQuality, this.degraded ? 'poor' : this.connectionQuality), name: 'System audio' });
      if (this.closed) { await media.localParticipant.unpublishTrack(local, false); return; }
      this.audioTrack = local; await this.applyAudioBitrate();
    });
    this.audioQueue = task.catch(() => {}); return task;
  }
  async camera(enabled: boolean): Promise<MediaStream | null> {
    if (!enabled) {
      this.cameraDesired = false; this.cameraGeneration++; this.cameraStarting = false; this.cameraRecoveryNotice = '';
      this.stopCameraCapture(); this.reportCamera();
      return null;
    }
    this.requireMedia();
    if (this.cameraDesired && (this.cameraStarting || this.cameraCapture?.track.mediaStreamTrack.readyState === 'live')) return this.cameraCapture?.stream ?? null;
    this.cameraDesired = true;
    return this.startCamera();
  }
  async cameraInput(deviceId: string): Promise<void> {
    const selected = deviceId || 'default';
    if (selected === this.cameraDevice) return;
    this.cameraDevice = selected;
    if (!this.cameraDesired) return;
    this.cameraGeneration++; this.cameraStarting = false; this.stopCameraCapture(); this.reportCamera();
    if (!this.closed && this.media?.state === ConnectionState.Connected) await this.startCamera();
  }
  private reportCamera() {
    const capture = this.cameraCapture;
    const published = this.media?.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    const live = Boolean(capture && capture.track === published && capture.track.mediaStreamTrack.readyState === 'live');
    const state: CameraState = !this.cameraDesired ? 'off' : this.cameraStarting ? 'starting' : this.media?.state !== ConnectionState.Connected ? 'reconnecting' : live ? 'live' : 'unavailable';
    this.cb.cameraState?.(state, this.cameraDesired);
  }
  private stopCameraCapture() {
    const capture = this.cameraCapture; this.cameraCapture = undefined;
    if (capture) {
      capture.track.stop();
      capture.stream.getTracks().forEach(source => { if (source !== capture.track.mediaStreamTrack) source.stop(); });
      void this.media?.localParticipant.unpublishTrack(capture.track, true).catch(() => {});
    }
    this.cb.camera?.(null);
  }
  private async recoverCamera(devices: MediaDeviceInfo[]): Promise<void> {
    if (this.closed || !this.cameraDesired) return;
    const available = devices.some(device => device.kind === 'videoinput' && (this.cameraDevice === 'default' || device.deviceId === this.cameraDevice));
    if (!available) {
      this.cameraGeneration++; this.cameraStarting = false; this.stopCameraCapture(); this.reportCamera();
      if (this.cameraRecoveryNotice !== 'missing') this.cb.activity('Selected camera is unavailable. Reconnect that camera or choose another device.');
      this.cameraRecoveryNotice = 'missing'; return;
    }
    if (this.cameraStarting || this.media?.state !== ConnectionState.Connected || this.cameraCapture?.track.mediaStreamTrack.readyState === 'live') return;
    const generation = this.cameraGeneration;
    let granted = false;
    try { granted = (await navigator.permissions?.query({ name: 'camera' as PermissionName }))?.state === 'granted'; } catch { /* Unknown permission never triggers a background prompt. */ }
    if (this.closed || !this.cameraDesired || generation !== this.cameraGeneration) return;
    if (!granted) {
      if (this.cameraRecoveryNotice !== 'permission') this.cb.activity('Camera is available. Turn the camera off and on to allow access and resume.');
      this.cameraRecoveryNotice = 'permission'; this.reportCamera(); return;
    }
    await this.startCamera();
  }
  private async startCamera(): Promise<MediaStream | null> {
    const media = this.media;
    if (!media || this.closed || !this.cameraDesired) return null;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.reportCamera();
      throw new Error('Camera capture requires HTTPS or localhost and a browser with camera support.');
    }
    const generation = ++this.cameraGeneration, device = this.cameraDevice;
    const current = () => !this.closed && this.cameraDesired && generation === this.cameraGeneration && media === this.media;
    this.cameraStarting = true; this.cameraRecoveryNotice = ''; this.stopCameraCapture(); this.reportCamera();
    let stream: MediaStream | undefined;
    let track: LocalVideoTrack | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false, video: { ...(device === 'default' ? {} : { deviceId: { exact: device } }), width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 30, max: 30 } },
      });
      if (!current()) { stream.getTracks().forEach(source => source.stop()); return null; }
      if (media.state !== ConnectionState.Connected) throw new Error('Wait for the room to reconnect before turning on the camera.');
      const source = stream.getVideoTracks()[0];
      if (!source || source.readyState !== 'live') throw new Error('No camera stream is available.');
      if (device !== 'default') {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!current()) { stream.getTracks().forEach(track => track.stop()); return null; }
        if (source.getSettings().deviceId !== device || !devices.some(value => value.kind === 'videoinput' && value.deviceId === device)) throw new Error('Selected camera is unavailable. Choose another camera or reconnect that device.');
      }
      track = new LocalVideoTrack(source, undefined, true);
      this.cameraCapture = { track, stream };
      source.addEventListener('ended', () => {
        if (!current() || this.cameraCapture?.track !== track) return;
        this.cameraGeneration++; this.cameraStarting = false; this.stopCameraCapture(); this.reportCamera();
        this.cb.activity('Camera stopped. Waiting for the selected device.');
        void this.recoverDevices().catch(error => this.cb.error(String(error)));
      }, { once: true });
      await media.localParticipant.publishTrack(track, { source: Track.Source.Camera, name: 'Camera', videoCodec: 'vp8', simulcast: true });
      if (current() && device !== 'default') {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (current() && !devices.some(value => value.kind === 'videoinput' && value.deviceId === device)) throw new Error('Selected camera is unavailable. Reconnect that camera or choose another device.');
      }
      if (!current()) {
        track.stop();
        await media.localParticipant.unpublishTrack(track, true).catch(() => {});
        return null;
      }
      this.cb.camera?.(stream);
      return stream;
    } catch (error) {
      stream?.getTracks().forEach(source => source.stop());
      if (this.cameraCapture?.track === track) this.cameraCapture = undefined;
      if (track) await media.localParticipant.unpublishTrack(track, true).catch(() => {});
      if (!current()) return null;
      this.cameraCapture = undefined;
      this.cb.camera?.(null);
      if (error instanceof Error && error.name === 'NotAllowedError') throw new Error('Camera permission was denied. Allow camera access in your browser or Windows settings.');
      if (error instanceof Error && error.name === 'NotFoundError') throw new Error('No camera found. Connect a camera and try again.');
      if (error instanceof Error && error.name === 'NotReadableError') throw new Error('Camera is unavailable. Check whether another app is using it.');
      if (error instanceof Error && error.name === 'OverconstrainedError') throw new Error('Selected camera is unavailable or cannot supply these settings. Choose another camera or reconnect that device.');
      throw error;
    } finally { if (current()) { this.cameraStarting = false; this.reportCamera(); } }
  }
  shareVideo(track: MediaStreamTrack | null, quality: VideoQuality = this.videoQuality): Promise<void> {
    const task = this.videoQueue.then(async () => {
      if (this.videoTrack) { await this.media?.localParticipant.unpublishTrack(this.videoTrack, false).catch(() => {}); this.videoTrack = undefined; }
      if (!track || this.closed) return;
      const media = this.requireMedia(); this.videoQuality = quality; track.contentHint = this.sharingMode === 'text' ? 'detail' : 'motion';
      const local = new LocalVideoTrack(track, undefined, true);
      await media.localParticipant.publishTrack(local, { ...videoPublishOptions(quality, this.videoFps, this.sharingMode), name: 'Screen video' });
      if (this.closed) { await media.localParticipant.unpublishTrack(local, false); return; }
      this.videoTrack = local;
    });
    this.videoQueue = task.catch(() => {}); return task;
  }
  async setVideoQuality(quality: VideoQuality): Promise<void> {
    this.videoQuality = quality; const track = this.videoTrack?.mediaStreamTrack; if (!track) return;
    const profile = VIDEO_PROFILES[quality];
    await track.applyConstraints({ width: { ideal: profile.width, max: profile.width }, height: { ideal: profile.height, max: profile.height }, frameRate: { ideal: this.videoFps, max: this.videoFps } });
    await this.shareVideo(track, quality);
  }
  async setAudioQuality(quality: AudioQuality): Promise<void> { this.audioQuality = quality; this.goodSamples = 0; await this.applyAudioBitrate(); }
  async videoPolicy(fps: VideoFps, mode: SharingMode) {
    if (![30, 45, 60].includes(fps) || !['text', 'motion'].includes(mode)) throw new Error('Choose a valid frame rate and screen mode.');
    this.videoFps = fps; this.sharingMode = mode;
    if (this.videoTrack) await this.setVideoQuality(this.videoQuality);
  }
  receiveQuality(id: string, height: number | 'auto') {
    const video = this.videos.get(id); if (!video) return;
    const publication = this.media?.remoteParticipants.get(video.publisherId || video.peerId)?.videoTrackPublications.get(id);
    if (!publication) return;
    if (height === 'auto') { publication.setVideoQuality(SubscriptionQuality.HIGH); return; }
    const dimensions = publication.dimensions;
    if (!dimensions?.width || !dimensions.height || !Number.isFinite(height) || height < 1) throw new Error('Host stream dimensions are not available yet. Use Auto.');
    publication.setVideoDimensions(cappedDimensions(dimensions.width, dimensions.height, height));
  }
  volumeSource(id: string, source: 'microphone' | 'screen_share_audio', volume: number) {
    const value = Math.max(0, Math.min(1, volume));
    this.sourceVolumes.set(`${id}:${source}`, value);
    for (const audio of this.audios.values()) if (audio.peerId === id && audio.source === source) audio.track.setVolume(value);
  }
  private async applyAudioBitrate(): Promise<void> {
    const sender = this.audioTrack?.sender; if (!sender) return;
    const params = sender.getParameters(); if (!params.encodings?.length) return;
    const effective = this.degraded && !['poor', 'lost'].includes(this.connectionQuality) ? 'poor' : this.connectionQuality;
    params.encodings[0].maxBitrate = audioBitrate(this.audioQuality, effective); params.encodings[0].priority = 'high';
    try { await sender.setParameters(params); } catch { /* SDK may concurrently reconfigure a sender during reconnect; retry next interval. */ }
  }
  private async adaptAudio() {
    if (this.closed || this.controllerBusy) return; this.controllerBusy = true;
    try {
      if (['poor', 'lost'].includes(this.connectionQuality)) { this.degraded = true; this.goodSamples = 0; }
      else if (this.degraded && ++this.goodSamples >= 3) { this.degraded = false; this.goodSamples = 0; }
      await this.applyAudioBitrate();
    } finally { this.controllerBusy = false; }
  }
  receiveVideo(enabled: boolean) {
    this.videoEnabled = enabled;
    for (const participant of this.media?.remoteParticipants.values() ?? []) for (const publication of participant.videoTrackPublications.values()) publication.setSubscribed(enabled);
  }
  private playbackMuted(source: Track.Source): boolean {
    return this.muted || (this.sharingAudio && !(source === Track.Source.Microphone ? this.listenVoice : this.listenShared));
  }
  private applyPlaybackPolicy() { for (const audio of this.audios.values()) audio.element.muted = this.playbackMuted(audio.source); }
  muteIncoming(muted: boolean) { this.muted = muted; this.applyPlaybackPolicy(); }
  listeningWhileSharing(voice: boolean, shared: boolean) { this.listenVoice = voice; this.listenShared = shared; this.applyPlaybackPolicy(); }
  captureRouting(sharing: boolean, excludesSelf = false) { this.sharingAudio = sharing; this.captureExcludesSelf = excludesSelf; this.applyPlaybackPolicy(); }
  volume(id: string, volume: number) { this.volumes.set(id, volume); for (const audio of this.audios.values()) if (audio.peerId === id) audio.track.setVolume(volume); }
  async output(id: string) {
    if (this.media) await this.media.switchActiveDevice('audiooutput', id || 'default');
    this.sink = id; this.cb.output?.(id);
    for (const [source, sink] of this.sourceSinks) await this.outputSource(source as 'microphone' | 'screen_share_audio', sink);
  }
  async outputSource(source: 'microphone' | 'screen_share_audio', id: string) {
    await Promise.all([...this.audios.values()].filter(audio => audio.source === source).map(audio => audio.track.setSinkId(id || this.sink || 'default')));
    this.sourceSinks.set(source, id);
  }
  async resumePlayback() { await this.media?.startAudio(); await Promise.all([...this.audios.values()].map(audio => audio.element.play())); this.cb.playbackBlocked(false); }
  async metrics(): Promise<Metrics> {
    let changed = false;
    for (const [id, video] of this.videos) {
      const publication = this.media?.remoteParticipants.get(video.publisherId || video.peerId)?.videoTrackPublications.get(id), dimensions = publication?.dimensions;
      const layers = publication?.trackInfo?.layers.map(layer => layer.height);
      if (video.width !== dimensions?.width || video.height !== dimensions?.height || String(video.layers) !== String(layers)) { this.videos.set(id, { ...video, width: dimensions?.width, height: dimensions?.height, layers }); changed = true; }
    }
    if (changed) this.cb.videos?.([...this.videos.values()]);
    const result: Metrics = { rtt: null, jitter: null, loss: 0, received: 0, sent: 0, connected: this.media?.remoteParticipants.size ?? 0,
      audioKbps: 0, videoKbps: 0, fps: 0, width: 0, height: 0, quality: this.degraded ? 'adapting to network' : this.connectionQuality, concealedSamples: 0 };
    result.captureDelivery = await window.audioShareDesktop?.getCaptureStats?.().catch(() => undefined);
    result.captureExcludesSelf = this.captureExcludesSelf; result.playback = [...this.audios.values()].map(a => ({ peerId: a.peerId, source: a.source, muted: a.element.muted, paused: a.element.paused, volume: a.element.volume, sink: (a.element as HTMLAudioElement & { sinkId?: string }).sinkId || 'default' }));
    result.capture = this.microphoneTrack?.mediaStreamTrack.getSettings(); result.audioSamples = 0; result.audioEnergy = 0;
    const tracks: (RemoteTrack | LocalTrack)[] = [...this.audios.values()].map(a => a.track);
    const mic = this.media?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track; if (mic) tracks.push(mic);
    tracks.push(...[...this.videos.values()].map(v => v.track)); if (this.audioTrack) tracks.push(this.audioTrack); if (this.videoTrack) tracks.push(this.videoTrack);
    const reports = await Promise.all(tracks.map(t => t.getRTCStatsReport().catch(() => undefined)));
    result.audio = [];
    reports.forEach((report, index) => {
      const track = tracks[index]; if (track.kind !== Track.Kind.Audio) return;
      const remote = [...this.audios.values()].find(a => a.track === track);
      const item: AudioDiagnostic = { direction: remote ? 'receive' : 'send', source: track.source, peerId: remote?.peerId, timestamp: 0, bytes: 0, packets: 0, samples: 0, energy: 0, concealed: 0, jitterBufferMs: 0 };
      report?.forEach(stat => {
        item.timestamp = Math.max(item.timestamp, stat.timestamp || 0);
        if (stat.type === 'inbound-rtp' && stat.kind === 'audio') { item.bytes += stat.bytesReceived || 0; item.packets += stat.packetsReceived || 0; item.samples += stat.totalSamplesReceived || 0; item.energy += stat.totalAudioEnergy || 0; item.concealed += stat.concealedSamples || 0; item.jitterBufferMs = stat.jitterBufferEmittedCount ? stat.jitterBufferDelay * 1000 / stat.jitterBufferEmittedCount : 0; }
        if (stat.type === 'outbound-rtp' && stat.kind === 'audio') { item.bytes += stat.bytesSent || 0; item.packets += stat.packetsSent || 0; }
        if (stat.type === 'media-source' && stat.kind === 'audio') { item.samples += (stat.totalSamplesDuration || 0) * (stat.clockRate || 48000); item.energy += stat.totalAudioEnergy || 0; }
      });
      result.audio!.push(item);
    });
    const seen = new Set<string>(); let audioBytes = 0, videoBytes = 0;
    for (const report of reports) report?.forEach(s => {
      if (seen.has(s.id)) return; seen.add(s.id);
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated && typeof s.currentRoundTripTime === 'number') result.rtt = Math.max(result.rtt ?? 0, s.currentRoundTripTime * 1000);
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) {
        const local = report?.get(s.localCandidateId), remote = report?.get(s.remoteCandidateId);
        result.route = `${local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'TURN relay' : 'Direct media'} · ${remote?.protocol || local?.protocol || 'unknown transport'}`;
      }
      if (s.type === 'inbound-rtp') {
        result.received += s.bytesReceived || 0; result.loss += Math.max(0, s.packetsLost || 0);
        if (s.kind === 'audio') { result.audioSamples! += s.totalSamplesReceived || 0; result.audioEnergy! += s.totalAudioEnergy || 0; result.jitter = Math.max(result.jitter ?? 0, (s.jitter || 0) * 1000); result.concealedSamples! += s.concealedSamples || 0; audioBytes += s.bytesReceived || 0; }
        else { result.freezes = (result.freezes || 0) + (s.freezeCount || 0); videoBytes += s.bytesReceived || 0; result.fps = Math.max(result.fps!, s.framesPerSecond || 0); result.width = Math.max(result.width!, s.frameWidth || 0); result.height = Math.max(result.height!, s.frameHeight || 0); }
      }
      if (s.type === 'outbound-rtp') {
        result.sent += s.bytesSent || 0;
        if (s.kind === 'audio') audioBytes += s.bytesSent || 0;
        else { videoBytes += s.bytesSent || 0; result.fps = Math.max(result.fps!, s.framesPerSecond || 0); result.width = Math.max(result.width!, s.frameWidth || 0); result.height = Math.max(result.height!, s.frameHeight || 0); }
      }
    });
    const now = performance.now();
    if (this.lastSample) { const seconds = (now - this.lastSample.time) / 1000; if (seconds > 0) { result.audioKbps = Math.max(0, audioBytes - this.lastSample.audio) * 8 / seconds / 1000; result.videoKbps = Math.max(0, videoBytes - this.lastSample.video) * 8 / seconds / 1000; } }
    this.lastSample = { time: now, audio: audioBytes, video: videoBytes }; return result;
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.abort?.abort(); clearInterval(this.controllerTimer);
    void this.setMicrophone(false);
    void this.camera(false);
    for (const id of [...this.audios.keys(), ...this.videos.keys()]) this.dropRemote(id);
    this.media?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.stop();
    void this.media?.disconnect(false); this.cb.microphone?.(false); this.cb.videos?.([]); this.cb.peers([], ''); this.cb.status('offline');
  }
}
