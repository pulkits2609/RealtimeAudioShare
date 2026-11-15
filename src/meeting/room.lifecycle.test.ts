import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Room } from './room';
import { ConnectionState, Track, RoomEvent } from 'livekit-client';
const capture = vi.hoisted(() => ({ pending: vi.fn() }));
vi.mock('livekit-client', async original => {
  const sdk = await original<typeof import('livekit-client')>();
  class LocalAudioTrack {
    isMuted = false; source = Track.Source.Microphone;
    constructor(public mediaStreamTrack: MediaStreamTrack) {}
    stop() { this.mediaStreamTrack.stop(); }
    on() { return this; }
    mute() { this.isMuted = true; return Promise.resolve(this); }
  }
  class LocalVideoTrack {
    source = Track.Source.Camera;
    constructor(public mediaStreamTrack: MediaStreamTrack) {}
    stop() { this.mediaStreamTrack.stop(); }
  }
  return { ...sdk, LocalAudioTrack, LocalVideoTrack, createLocalAudioTrack: (...args: unknown[]) => capture.pending(...args) };
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const publication = { track: undefined as unknown, source: Track.Source.Microphone };
  const cameraPublication = { track: undefined as unknown, source: Track.Source.Camera };
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const media = { on: (event: string, callback: (...args: unknown[]) => void) => { listeners.set(event, callback); }, state: ConnectionState.Connected, remoteParticipants: new Map(), localParticipant: {
    identity: 'self',
    getTrackPublication: (source: Track.Source) => { const value = source === Track.Source.Camera ? cameraPublication : publication; return value.track ? value : undefined; },
    publishTrack: vi.fn(async (track: unknown, options?: { source?: Track.Source }) => { (options?.source === Track.Source.Camera ? cameraPublication : publication).track = track; }),
    unpublishTrack: vi.fn(async (track: unknown) => { if (publication.track === track) publication.track = undefined; if (cameraPublication.track === track) cameraPublication.track = undefined; }),
    publishData: vi.fn<(payload: Uint8Array, options: unknown) => Promise<void>>(async () => {}),
  }, switchActiveDevice: vi.fn(async () => true), disconnect: vi.fn(async () => {}) };
  const state = vi.fn(), camera = vi.fn(), cameraState = vi.fn(), activity = vi.fn(), error = vi.fn(), peers = vi.fn(), chat = vi.fn();
  const room = new Room({ peers, status() {}, activity, error, playbackBlocked() {}, transport() {}, microphone: state, camera, cameraState, chat });
  Object.assign(room, { media });
  (room as unknown as { bindEvents(media: unknown): void }).bindEvents(media);
  return { room, media, state, publication, cameraPublication, camera, cameraState, activity, error, peers, chat, emit: (event: string, ...args: unknown[]) => listeners.get(event)?.(...args) };
}
function raw(deviceId = 'default') { const track = { readyState: 'live', stop: vi.fn(function () { track.readyState = 'ended'; }), addEventListener: vi.fn(), getSettings: () => ({ sampleRate: 48000, channelCount: 1, deviceId }) }; return track; }
beforeEach(() => { vi.stubGlobal('window', { isSecureContext: true }); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('OFF completes while microphone permission is pending and discards the late capture', async () => {
  const f = fixture(), pending = deferred<MediaStream>(), track = raw();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => pending.promise } });
  capture.pending.mockImplementation(() => pending.promise);
  const starting = f.room.setMicrophone(true);
  await Promise.resolve();
  const stopped = vi.fn(); void f.room.setMicrophone(false).then(stopped);
  await vi.waitFor(() => expect(stopped).toHaveBeenCalledOnce(), { timeout: 100 });
  pending.resolve({ getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream);
  await starting;
  expect(track.stop).toHaveBeenCalled(); expect(f.media.localParticipant.publishTrack).not.toHaveBeenCalled();
});
it('OFF releases capture immediately even when signaling is reconnecting', async () => {
  const f = fixture(), track = raw();
  Object.assign(f.room, { microphoneTrack: { stop: track.stop }, microphoneDesired: true });
  f.media.state = ConnectionState.Reconnecting;
  await f.room.setMicrophone(false);
  expect(track.stop).toHaveBeenCalledOnce(); expect(f.state).toHaveBeenLastCalledWith(false);
});

it('SDK republish reconciles actual microphone state without changing user intent', async () => {
  const f = fixture(), track = raw();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [track] }) } });
  await f.room.setMicrophone(true);
  expect(f.state).toHaveBeenLastCalledWith(true);
  const owned = f.publication.track; f.publication.track = undefined;
  f.emit(RoomEvent.LocalTrackUnpublished, { source: Track.Source.Microphone, track: owned });
  expect(f.state).toHaveBeenLastCalledWith(false);
  f.publication.track = owned; f.emit(RoomEvent.LocalTrackPublished, f.publication);
  expect(f.state).toHaveBeenLastCalledWith(true);
  await f.room.setMicrophone(false);
  f.publication.track = owned; f.emit(RoomEvent.LocalTrackPublished, f.publication);
  expect(track.stop).toHaveBeenCalled(); expect(f.state).toHaveBeenLastCalledWith(false);
});
it('a fixed microphone waits for its own device and recovers on replug', async () => {
  const f = fixture(), first = raw('fixed'), replacement = raw('fixed'); let devices: unknown[] = [{ kind: 'audioinput', deviceId: 'fixed' }];
  const gum = vi.fn().mockResolvedValueOnce({ getAudioTracks: () => [first], getTracks: () => [first] }).mockResolvedValueOnce({ getAudioTracks: () => [replacement], getTracks: () => [replacement] });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: gum, enumerateDevices: async () => devices } });
  await f.room.microphoneInput('fixed'); await f.room.setMicrophone(true);
  devices = [{ kind: 'audioinput', deviceId: 'other' }]; await f.room.recoverDevices();
  expect(first.stop).toHaveBeenCalled(); expect(gum).toHaveBeenCalledTimes(1);
  devices = [{ kind: 'audioinput', deviceId: 'fixed' }]; await f.room.recoverDevices();
  expect(gum).toHaveBeenCalledTimes(2);
  expect(gum.mock.calls[1][0].audio.deviceId).toEqual({ exact: 'fixed' });
});
it('default microphone follows default-device changes and removed output falls back through SDK', async () => {
  const f = fixture(), first = raw(), replacement = raw(); let group = 'first';
  const gum = vi.fn().mockResolvedValueOnce({ getAudioTracks: () => [first] }).mockResolvedValueOnce({ getAudioTracks: () => [replacement] });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: gum, enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'default', groupId: group }] } });
  await f.room.setMicrophone(true); await f.room.recoverDevices();
  await f.room.output('unplugged'); group = 'second'; await f.room.recoverDevices();
  expect(gum).toHaveBeenCalledTimes(2); expect(first.stop).toHaveBeenCalled();
  expect(f.media.switchActiveDevice).toHaveBeenLastCalledWith('audiooutput', 'default');
});
it('voice and shared listening choices apply to existing and replacement tracks', () => {
  const f = fixture(); const voice = { element: { muted: false }, source: Track.Source.Microphone }, shared = { element: { muted: false }, source: Track.Source.ScreenShareAudio };
  const audios = new Map([['voice', voice], ['shared', shared]]); Object.assign(f.room, { audios });
  f.room.captureRouting(true); expect(voice.element.muted).toBe(true); expect(shared.element.muted).toBe(true);
  f.room.listeningWhileSharing(true, false); expect(voice.element.muted).toBe(false); expect(shared.element.muted).toBe(true);
  const late = { element: { muted: false }, source: Track.Source.ScreenShareAudio }; audios.set('late', late);
  f.room.captureRouting(true); expect(late.element.muted).toBe(true);
  f.room.listeningWhileSharing(false, true); expect(voice.element.muted).toBe(true); expect(late.element.muted).toBe(false);
  f.room.captureRouting(false); expect(voice.element.muted).toBe(false);
});
it('OFF revokes a pending desktop consent without starting capture later', async () => {
  const f = fixture(), consent = deferred<void>(), end = vi.fn(async () => {}), gum = vi.fn();
  vi.stubGlobal('window', { isSecureContext: true, audioShareDesktop: { beginMicrophoneSession: () => consent.promise, endMicrophoneSession: end } });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: gum, enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'chosen' }] } });
  const starting = f.room.setMicrophone(true); await f.room.setMicrophone(false);
  expect(end).toHaveBeenCalledOnce(); consent.resolve(); await starting; expect(gum).not.toHaveBeenCalled();
});
it('a superseded microphone permission result cannot replace the chosen input', async () => {
  const f = fixture(), pending = deferred<MediaStream>(), old = raw(), chosen = raw('chosen');
  const gum = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValueOnce({ getAudioTracks: () => [chosen], getTracks: () => [chosen] });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: gum, enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'chosen' }] } });
  const initial = f.room.setMicrophone(true); await Promise.resolve();
  await f.room.microphoneInput('chosen');
  pending.resolve({ getAudioTracks: () => [old], getTracks: () => [old] } as unknown as MediaStream); await initial;
  expect(old.stop).toHaveBeenCalledOnce(); expect(chosen.stop).not.toHaveBeenCalled(); expect(f.media.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
  expect(gum.mock.calls[1][0].audio.deviceId).toEqual({ exact: 'chosen' });
});

it('removing a fixed input during pending publication immediately stops capture and rejects late publication', async () => {
  const f = fixture(), track = raw('fixed'), publish = deferred<void>(); let present = true;
  const devices = async () => present ? [{ kind: 'audioinput', deviceId: 'fixed' }] : [];
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }), enumerateDevices: devices } });
  f.media.localParticipant.publishTrack.mockImplementation(async value => { f.publication.track = value; await publish.promise; });
  await f.room.microphoneInput('fixed'); const starting = f.room.setMicrophone(true);
  await vi.waitFor(() => expect(f.media.localParticipant.publishTrack).toHaveBeenCalledOnce());
  present = false; await f.room.recoverDevices(); expect(track.stop).toHaveBeenCalled(); expect(f.state).toHaveBeenLastCalledWith(false);
  publish.resolve(); await starting; expect(f.state).toHaveBeenLastCalledWith(false);
});

it('a fixed microphone fails closed when the OS returns a different input', async () => {
  const f = fixture(), track = raw('unexpected-default');
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }), enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'fixed' }] } });
  await f.room.microphoneInput('fixed'); await expect(f.room.setMicrophone(true)).rejects.toThrow('Selected microphone is unavailable');
  expect(track.stop).toHaveBeenCalled(); expect(f.media.localParticipant.publishTrack).not.toHaveBeenCalled(); expect(f.state).toHaveBeenLastCalledWith(false);
});

it('stopping a pending camera request discards the late stream without publishing', async () => {
  const f = fixture(), pending = deferred<MediaStream>(), track = raw();
  const getUserMedia = vi.fn(() => pending.promise);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  const starting = f.room.camera(true);
  await f.room.camera(false);
  pending.resolve({ getTracks: () => [track] } as unknown as MediaStream);
  await expect(starting).resolves.toBeNull();
  expect(getUserMedia).toHaveBeenCalledWith({ audio: false, video: expect.any(Object) });
  expect(track.stop).toHaveBeenCalledOnce();
  expect(f.media.localParticipant.publishTrack).not.toHaveBeenCalled();
});

function videoStream(track: ReturnType<typeof raw>) { return { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream; }

it('a fixed camera uses and verifies an exact device while default remains an OS selection', async () => {
  const f = fixture(), fixed = raw('camera-fixed'), fallback = raw('camera-default');
  const gum = vi.fn().mockResolvedValueOnce(videoStream(fixed)).mockResolvedValueOnce(videoStream(fallback));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: gum, enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'camera-fixed' }] } });
  await f.room.cameraInput('camera-fixed'); await f.room.camera(true);
  expect(gum.mock.calls[0][0].video.deviceId).toEqual({ exact: 'camera-fixed' });
  expect(f.cameraState).toHaveBeenLastCalledWith('live', true);
  await f.room.camera(false); await f.room.cameraInput('default'); await f.room.camera(true);
  expect(gum.mock.calls[1][0].video.deviceId).toBeUndefined();
  expect(fixed.stop).toHaveBeenCalled();
});

it('switching camera during permission cannot publish the superseded source', async () => {
  const f = fixture(), pending = deferred<MediaStream>(), old = raw('old'), chosen = raw('chosen');
  const gum = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(videoStream(chosen));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: gum, enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'chosen' }] } });
  const starting = f.room.camera(true); await Promise.resolve();
  await f.room.cameraInput('chosen');
  pending.resolve(videoStream(old)); await starting;
  expect(old.stop).toHaveBeenCalledOnce(); expect(chosen.stop).not.toHaveBeenCalled();
  expect(f.media.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
  expect(f.cameraState).toHaveBeenLastCalledWith('live', true);
});

it('a fixed camera fails closed when the OS returns another device', async () => {
  const f = fixture(), unexpected = raw('another-camera');
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => videoStream(unexpected), enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'fixed' }] } });
  await f.room.cameraInput('fixed');
  await expect(f.room.camera(true)).rejects.toThrow('Selected camera is unavailable');
  expect(unexpected.stop).toHaveBeenCalled(); expect(f.media.localParticipant.publishTrack).not.toHaveBeenCalled();
  expect(f.cameraState).toHaveBeenLastCalledWith('unavailable', true);
});

it('a removed fixed camera waits for its own device and recovers independently of microphone intent', async () => {
  const f = fixture(), first = raw('fixed'), replacement = raw('fixed');
  let devices = [{ kind: 'videoinput', deviceId: 'fixed' }];
  const gum = vi.fn().mockResolvedValueOnce(videoStream(first)).mockResolvedValueOnce(videoStream(replacement));
  vi.stubGlobal('navigator', { permissions: { query: async () => ({ state: 'granted' }) }, mediaDevices: { getUserMedia: gum, enumerateDevices: async () => devices } });
  await f.room.cameraInput('fixed'); await f.room.camera(true);
  devices = [{ kind: 'videoinput', deviceId: 'other' }]; await f.room.recoverDevices();
  expect(first.stop).toHaveBeenCalled(); expect(gum).toHaveBeenCalledTimes(1);
  expect(f.cameraState).toHaveBeenLastCalledWith('unavailable', true);
  devices = [{ kind: 'videoinput', deviceId: 'fixed' }]; await f.room.recoverDevices();
  expect(gum).toHaveBeenCalledTimes(2); expect(gum.mock.calls[1][0].video.deviceId).toEqual({ exact: 'fixed' });
  expect(f.cameraState).toHaveBeenLastCalledWith('live', true);
});

it('camera recovery never creates a fresh permission prompt or restarts after OFF', async () => {
  const f = fixture(), first = raw('fixed'); let devices = [{ kind: 'videoinput', deviceId: 'fixed' }];
  const gum = vi.fn().mockResolvedValue(videoStream(first));
  vi.stubGlobal('navigator', { permissions: { query: async () => ({ state: 'prompt' }) }, mediaDevices: { getUserMedia: gum, enumerateDevices: async () => devices } });
  await f.room.cameraInput('fixed'); await f.room.camera(true);
  devices = []; await f.room.recoverDevices();
  devices = [{ kind: 'videoinput', deviceId: 'fixed' }]; await f.room.recoverDevices();
  expect(gum).toHaveBeenCalledTimes(1);
  expect(f.activity).toHaveBeenCalledWith(expect.stringContaining('Turn the camera off and on'));
  await f.room.camera(false); await f.room.recoverDevices();
  expect(gum).toHaveBeenCalledTimes(1); expect(f.cameraState).toHaveBeenLastCalledWith('off', false);
});

it('camera OFF immediately stops a pending publication while reconnecting and late SDK events stay OFF', async () => {
  const f = fixture(), track = raw(), publish = deferred<void>();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => videoStream(track) } });
  f.media.localParticipant.publishTrack.mockImplementation(async value => { f.cameraPublication.track = value; await publish.promise; });
  const starting = f.room.camera(true); await vi.waitFor(() => expect(f.media.localParticipant.publishTrack).toHaveBeenCalledOnce());
  const stale = f.cameraPublication.track;
  f.media.state = ConnectionState.Reconnecting; await f.room.camera(false);
  expect(track.stop).toHaveBeenCalled(); expect(f.cameraState).toHaveBeenLastCalledWith('off', false);
  publish.resolve(); await starting;
  f.emit(RoomEvent.LocalTrackPublished, { source: Track.Source.Camera, track: stale });
  expect(f.camera).toHaveBeenLastCalledWith(null); expect(f.cameraState).toHaveBeenLastCalledWith('off', false);
});

it('removing a fixed camera during pending publication stops it and cannot announce a late preview', async () => {
  const f = fixture(), track = raw('fixed'), publish = deferred<void>(); let present = true;
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => videoStream(track), enumerateDevices: async () => present ? [{ kind: 'videoinput', deviceId: 'fixed' }] : [] } });
  f.media.localParticipant.publishTrack.mockImplementation(async value => { f.cameraPublication.track = value; await publish.promise; });
  await f.room.cameraInput('fixed'); const starting = f.room.camera(true);
  await vi.waitFor(() => expect(f.media.localParticipant.publishTrack).toHaveBeenCalledOnce());
  present = false; await f.room.recoverDevices();
  expect(track.stop).toHaveBeenCalled(); expect(f.cameraState).toHaveBeenLastCalledWith('unavailable', true);
  publish.resolve(); await starting;
  expect(f.camera).toHaveBeenLastCalledWith(null);
});

it('reconnected transport recovers only a previously desired granted camera', async () => {
  const f = fixture(), first = raw('fixed'), replacement = raw('fixed'); let present = true;
  const gum = vi.fn().mockResolvedValueOnce(videoStream(first)).mockResolvedValueOnce(videoStream(replacement));
  vi.stubGlobal('navigator', { permissions: { query: async () => ({ state: 'granted' }) }, mediaDevices: { getUserMedia: gum, enumerateDevices: async () => present ? [{ kind: 'videoinput', deviceId: 'fixed' }] : [] } });
  await f.room.cameraInput('fixed'); await f.room.camera(true);
  f.media.state = ConnectionState.Reconnecting; f.emit(RoomEvent.Reconnecting);
  present = false; await f.room.recoverDevices();
  expect(f.cameraState).toHaveBeenLastCalledWith('reconnecting', true);
  present = true; f.media.state = ConnectionState.Connected; f.emit(RoomEvent.Reconnected);
  await vi.waitFor(() => expect(f.cameraState).toHaveBeenLastCalledWith('live', true));
  expect(gum).toHaveBeenCalledTimes(2);
  await f.room.camera(false); f.emit(RoomEvent.Reconnected); await Promise.resolve();
  expect(gum).toHaveBeenCalledTimes(2);
});

it('disconnect closes camera and fences a permission response that arrives after the room ended', async () => {
  const f = fixture(), pending = deferred<MediaStream>(), track = raw();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => pending.promise } });
  const starting = f.room.camera(true);
  f.emit(RoomEvent.Disconnected); pending.resolve(videoStream(track)); await starting;
  expect(track.stop).toHaveBeenCalled(); expect(f.media.localParticipant.publishTrack).not.toHaveBeenCalled();
  await expect(f.room.camera(false)).resolves.toBeNull();
  expect(f.cameraState).toHaveBeenLastCalledWith('off', false);
});

it('participant roles are shown only from recognized managed server metadata', () => {
  const f = fixture();
  for (const [id, metadata] of [['owner', '{"managed":true,"role":"owner"}'], ['unmanaged', '{"role":"owner"}'], ['unknown', '{"managed":true,"role":"administrator"}']] as const) {
    f.media.remoteParticipants.set(id, { identity: id, name: id, metadata, audioTrackPublications: new Map(), videoTrackPublications: new Map() });
  }
  f.emit(RoomEvent.ParticipantConnected, f.media.remoteParticipants.get('owner'));
  const peers = f.peers.mock.lastCall![0];
  expect(peers.find((peer: { id: string }) => peer.id === 'owner').role).toBe('owner');
  expect(peers.find((peer: { id: string }) => peer.id === 'unmanaged').role).toBeUndefined();
  expect(peers.find((peer: { id: string }) => peer.id === 'unknown').role).toBeUndefined();
});

it('chat retry preserves message identity and timestamp after ambiguous publication failure', async () => {
  const f = fixture(), messageId = '11111111-1111-4111-8111-111111111111';
  f.media.localParticipant.publishData.mockRejectedValueOnce(new Error('Network interrupted')).mockResolvedValue(undefined);
  await expect(f.room.sendChat('Retry this message', messageId)).rejects.toThrow('Network interrupted');
  expect(f.chat).not.toHaveBeenCalled();
  await f.room.sendChat('Retry this message', messageId);
  const encoded = f.media.localParticipant.publishData.mock.calls.map(call => JSON.parse(new TextDecoder().decode(call[0])));
  expect(encoded[0].id).toBe(messageId); expect(encoded[1]).toEqual(encoded[0]);
  expect(f.chat).toHaveBeenCalledOnce();
  await f.room.sendChat('Retry this message', messageId);
  expect(f.chat).toHaveBeenCalledOnce();
  expect(f.media.localParticipant.publishData).toHaveBeenCalledTimes(2);
});

it('chat rejects invalid retry IDs and cannot reuse an ID for different content', async () => {
  const f = fixture();
  await expect(f.room.sendChat('hello', 'invalid id')).rejects.toThrow();
  const id = '22222222-2222-4222-8222-222222222222';
  await f.room.sendChat('hello', id);
  await expect(f.room.sendChat('different content', id)).rejects.toThrow('different message');
  expect(f.media.localParticipant.publishData).toHaveBeenCalledTimes(1);
});
