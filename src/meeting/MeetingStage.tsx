import { useEffect, useRef, useState, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import type { Peer, RemoteVideo } from './types';
import type { AudioDiagnostic, PlaybackDiagnostic } from './room';
import { receiverHeights } from './video-policy';
import './stage-layout.css';

type ChangeQuality = (id: string, height: number | 'auto') => void;
const noAudioMetrics: AudioDiagnostic[] = [];
const noPlayback: PlaybackDiagnostic[] = [];

function RemotePicture({ video, label }: { video: RemoteVideo; label: string }) {
  const element = useRef<HTMLVideoElement>(null);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    let active = true;
    video.track.attach(target);
    void target.play().then(() => {
      if (active) setPlaybackFailed(false);
    }).catch(() => {
      if (active) setPlaybackFailed(true);
    });
    return () => {
      active = false;
      video.track.detach(target);
    };
  }, [video.track]);
  return <>
    <video ref={element} autoPlay playsInline muted aria-label={label}/>
    {playbackFailed && <button className="video-play-button button primary" onClick={() => {
      void element.current?.play().then(() => setPlaybackFailed(false)).catch(() => {});
    }}>Play video</button>}
  </>;
}

function LocalPicture({ stream, label }: { stream: MediaStream; label: string }) {
  const element = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const target = element.current;
    if (target) target.srcObject = stream;
    return () => { if (target) target.srcObject = null; };
  }, [stream]);
  return <video ref={element} autoPlay playsInline muted aria-label={label}/>;
}

function ScreenTile({ video, onQuality }: { video: RemoteVideo; onQuality: ChangeQuality }) {
  const tile = useRef<HTMLElement>(null);
  const [quality, setQuality] = useState('auto');
  const [fullscreenError, setFullscreenError] = useState('');
  const heights = receiverHeights(video.width, video.height, video.layers);
  const qualityAvailable = quality === 'auto' || heights.includes(Number(quality));
  useEffect(() => {
    if (qualityAvailable) return;
    setQuality('auto');
    onQuality(video.id, 'auto');
  }, [qualityAvailable, onQuality, video.id]);
  return <article className="video-tile meeting-screen" ref={tile} data-testid="remote-video">
    <RemotePicture video={video} label={video.name + "'s screen"}/>
    <div className="video-caption">
      <strong>{video.name}’s screen</strong>
      <select aria-label={video.name + ' screen quality'} value={quality} onChange={event => {
        const value = event.target.value;
        setQuality(value);
        onQuality(video.id, value === 'auto' ? 'auto' : Number(value));
      }}>
        <option value="auto">Auto quality</option>
        {heights.map(height => <option key={height} value={height}>Up to {height}p</option>)}
      </select>
      <button className="text-button" disabled={!document.fullscreenEnabled} aria-label={'Fullscreen ' + video.name + "'s screen"} onClick={() => {
        const target = tile.current?.querySelector('video');
        if (target?.requestFullscreen) void target.requestFullscreen().catch(() => setFullscreenError('Fullscreen was blocked. Try again from the active window.'));
      }}>Fullscreen ↗</button>
    </div>
    {fullscreenError && <p role="status">{fullscreenError}</p>}
  </article>;
}

function ParticipantTile({ name, self, microphone, speaking, camera, preview }: {
  name: string;
  self?: boolean;
  microphone?: boolean;
  speaking?: boolean;
  camera?: RemoteVideo;
  preview?: MediaStream | null;
}) {
  return <article className={'meeting-person' + (speaking ? ' speaking' : '')}
    data-testid={camera ? 'remote-camera' : self && preview ? 'local-camera' : undefined}>
    {preview
      ? <LocalPicture stream={preview} label="Your camera preview"/>
      : camera
        ? <RemotePicture video={camera} label={name + "'s camera"}/>
        : <span className="meeting-avatar" aria-hidden="true">{Array.from(name.trim())[0]?.toUpperCase() || '?'}</span>}
    <div className="meeting-person-caption">
      <strong>{name}{self && <small> (you)</small>}</strong>
      <span title={speaking ? 'Speaking' : microphone ? 'Mic on' : 'Mic off'}>
        {speaking ? 'Speaking' : microphone ? 'Mic on' : 'Mic off'}
      </span>
    </div>
  </article>;
}

export function MeetingStage({ name, microphone, peers, videos, camera, screen, receiveVideo, onQuality,
  sharing = false, localAudioLevel = 0, sourceVolumes = {}, volumes = {}, onSourceVolume, onVolume,
  audioActivity = noPlayback, audioMetrics = noAudioMetrics,
}: {
  name: string;
  microphone: boolean;
  peers: Peer[];
  videos: RemoteVideo[];
  camera: MediaStream | null;
  screen: MediaStream | null;
  receiveVideo: boolean;
  onQuality: ChangeQuality;
  sharing?: boolean;
  localAudioLevel?: number;
  sourceVolumes?: Record<string, number>;
  volumes?: Record<string, number>;
  onSourceVolume?(peerId: string, source: 'microphone' | 'screen_share_audio', value: number): void;
  onVolume?(peerId: string, value: number): void;
  audioActivity?: PlaybackDiagnostic[];
  audioMetrics?: AudioDiagnostic[];
}) {
  const [layout, setLayout] = useState<'auto' | 'grid' | 'focus'>('auto');
  const [pinned, setPinned] = useState<string[]>([]);
  const [focused, setFocused] = useState('');
  const [fullscreenError, setFullscreenError] = useState('');
  const reducedMotion = useReducedMotion();
  const previousEnergy = useRef(new Map<string, { energy: number; timestamp: number }>());
  const [activeAudio, setActiveAudio] = useState<Set<string>>(new Set());
  useEffect(() => {
    const next = new Map<string, { energy: number; timestamp: number }>(), active = new Set<string>();
    for (const metric of audioMetrics) {
      if (metric.direction !== 'receive' || metric.source !== 'screen_share_audio' || !metric.peerId) continue;
      const before = previousEnergy.current.get(metric.peerId);
      if (before && metric.timestamp > before.timestamp && metric.energy > before.energy + 0.000001) active.add(metric.peerId);
      next.set(metric.peerId, { energy: metric.energy, timestamp: metric.timestamp });
    }
    previousEnergy.current = next; setActiveAudio(active);
  }, [audioMetrics]);
  const screens = receiveVideo ? videos.filter(video => video.source === 'screen_share') : [];
  const cameras = new Map(receiveVideo ? videos.filter(video => video.source === 'camera').map(video => [video.peerId, video]) : []);
  const sources: { id: string; label: string; kind: 'participant' | 'screen' | 'audio'; content: ReactNode }[] = [];
  const volume = (peer: Peer, source: 'microphone' | 'screen_share_audio') => <label className="tile-volume">
    {source === 'microphone' ? 'Voice' : 'Device audio'} volume
    <input aria-label={`${peer.name} ${source === 'microphone' ? 'voice' : 'device audio'} volume`} type="range" min="0" max="1" step="0.01"
      value={sourceVolumes[`${peer.id}:${source}`] ?? 1} onChange={event => onSourceVolume?.(peer.id, source, Number(event.target.value))} />
  </label>;
  function audioTile(owner: string, id: string, self: boolean, peer?: Peer) {
    const playback = audioActivity.find(item => item.peerId === id && item.source === 'screen_share_audio');
    const measured = self ? localAudioLevel > .008 : activeAudio.has(id);
    return <article className={'device-audio-tile' + (measured ? ' audio-active' : '')} data-testid="device-audio-tile">
      <div className="audio-source-icon" aria-hidden="true">♫</div>
      <strong>{owner}{self ? ' (you)' : ''} · Device audio</strong>
      <span className="audio-source-state"><span className="audio-activity-dot" aria-hidden="true"/>{playback?.muted ? 'Muted locally' : playback?.paused ? 'Playback paused' : measured ? 'Audio activity' : 'Sharing device audio'}</span>
      {self ? <meter min={0} max={1} value={Math.min(1, Math.max(0, localAudioLevel))} aria-label="Your device audio activity"/> : peer && <>
        {volume(peer, 'screen_share_audio')}
        <button className="tile-action" type="button" onClick={() => onSourceVolume?.(id, 'screen_share_audio', (sourceVolumes[`${id}:screen_share_audio`] ?? 1) > 0 ? 0 : 1)}>
          {(sourceVolumes[`${id}:screen_share_audio`] ?? 1) > 0 ? 'Mute source' : 'Listen to source'}
        </button>
      </>}
    </article>;
  }
  sources.push({ id: 'self:participant', label: `${name || 'You'} · Camera`, kind: 'participant', content: <ParticipantTile name={name} self microphone={microphone} preview={camera}/> });
  if (screen) sources.push({ id: 'self:screen', label: 'Your Screen', kind: 'screen', content: <article className="video-tile meeting-screen"><LocalPicture stream={screen} label="Your shared screen preview"/><div className="video-caption"><strong>Your Screen</strong><span>Sharing live</span></div></article> });
  if (sharing) sources.push({ id: 'self:audio', label: 'Your Device audio', kind: 'audio', content: audioTile(name, 'self', true) });
  const seenVideos = new Set<string>();
  for (const peer of peers) {
    sources.push({ id: `peer:${peer.id}`, label: `${peer.name} · Camera`, kind: 'participant', content: <>
      <ParticipantTile name={peer.name} microphone={peer.microphone} speaking={peer.speaking} camera={peer.cameraStreaming ? cameras.get(peer.id) : undefined}/>
      <div className="participant-listening">{volume(peer, 'microphone')}{onVolume && <label className="tile-volume">Person volume<input aria-label={`${peer.name} volume`} type="range" min="0" max="1" step="0.01" value={volumes[peer.id] ?? 1} onChange={event => onVolume(peer.id, Number(event.target.value))}/></label>}</div>
    </> });
    for (const video of screens.filter(video => video.peerId === peer.id)) {
      if (seenVideos.has(video.id)) continue; seenVideos.add(video.id);
      sources.push({ id: `screen:${video.id}`, label: `${peer.name} · Screen`, kind: 'screen', content: <ScreenTile video={video} onQuality={onQuality}/> });
    }
    if (peer.streaming) sources.push({ id: `audio:${peer.id}`, label: `${peer.name} · Device audio`, kind: 'audio', content: audioTile(peer.name, peer.id, false, peer) });
  }
  // Preserve a just-arrived publication even if its roster update is a tick later.
  for (const video of screens) if (!seenVideos.has(video.id)) { seenVideos.add(video.id); sources.push({ id: `screen:${video.id}`, label: `${video.name} · Screen`, kind: 'screen', content: <ScreenTile video={video} onQuality={onQuality}/> }); }
  const sourceIds = sources.map(source => source.id).join('|');
  useEffect(() => {
    const ids = new Set(sourceIds.split('|'));
    setPinned(old => old.every(id => ids.has(id)) ? old : old.filter(id => ids.has(id)));
    setFocused(old => !old || ids.has(old) ? old : '');
  }, [sourceIds]);
  const focusId = sources.some(source => source.id === focused) ? focused : pinned.find(id => sources.some(source => source.id === id)) || sources.find(source => source.kind === 'screen')?.id || 'self:participant';
  const focusLayout = layout === 'focus' || (layout === 'auto' && sources.some(source => source.kind === 'screen'));

  return <section className="meeting-stage source-workspace" aria-label="Meeting view">
    <div className="meeting-section-heading stage-layout-controls"><h2>Participants <span>{peers.length + 1}</span></h2>
      <label>Layout<select aria-label="Meeting layout" value={layout} onChange={event => setLayout(event.target.value as typeof layout)}><option value="auto">Auto</option><option value="grid">Grid</option><option value="focus">Focus</option></select></label>
      {(focusLayout || pinned.length > 0) && <button className="tile-action" onClick={() => { setLayout('grid'); setPinned([]); setFocused(''); }}>Return to gallery</button>}
      {!receiveVideo && <span className="meeting-audio-only">Audio-only listening is on</span>}
    </div>
    {peers.length === 0 && <p className="stage-empty-note">You’re the first one here. Invite someone to join this room.</p>}
    {fullscreenError && <p role="status">{fullscreenError}</p>}
    <div className={'source-grid' + (focusLayout ? ' focus-layout' : '')}>
      {sources.map(source => <motion.div key={source.id} layout={reducedMotion ? false : 'position'} transition={{ duration: .2 }}
        className={`source-tile source-${source.kind}${pinned.includes(source.id) ? ' pinned' : ''}${focusLayout && source.id === focusId ? ' focused' : ''}`}
        data-source-id={source.id} data-pinned={pinned.includes(source.id) || undefined}>
        <div className="source-tile-heading"><span>{source.label}</span><span className="source-badge">{source.kind === 'screen' ? 'Screen' : source.kind === 'audio' ? 'Device audio' : 'Participant'}</span></div>
        <div className="source-tile-content">{source.content}</div>
        <div className="source-tile-actions">
          <button type="button" className="tile-action" aria-label={`${pinned.includes(source.id) ? 'Unpin' : 'Pin'} ${source.label}`} aria-pressed={pinned.includes(source.id)} onClick={() => setPinned(old => old.includes(source.id) ? old.filter(id => id !== source.id) : [...old, source.id])}>{pinned.includes(source.id) ? 'Unpin' : 'Pin'}</button>
          <button type="button" className="tile-action" aria-label={`Focus ${source.label}`} onClick={() => { setFocused(source.id); setLayout('focus'); }}>Focus</button>
          <button type="button" className="tile-action" disabled={!document.fullscreenEnabled} aria-label={`Fullscreen tile ${source.label}`} onClick={event => {
            const target = event.currentTarget.closest<HTMLElement>('.source-tile');
            void target?.requestFullscreen?.().catch(() => setFullscreenError('Fullscreen was blocked. Try again from the active window.'));
          }}>Fullscreen</button>
        </div>
      </motion.div>)}
    </div>
  </section>;
}

