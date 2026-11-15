import type { RemoteVideoTrack } from 'livekit-client';
export interface Peer { id: string; name: string; streaming: boolean; videoStreaming?: boolean; cameraStreaming?: boolean; speaking?: boolean; microphone?: boolean; role?: 'owner' | 'moderator' | 'participant' | 'viewer' }
export interface RemoteVideo { source: 'camera' | 'screen_share'; id: string; peerId: string; publisherId?: string; name: string; track: RemoteVideoTrack; width?: number; height?: number; layers?: number[] }
export interface Signal { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null }
export type ServerMessage =
  | { type: 'welcome'; selfId: string; peers: Peer[]; iceServers: RTCIceServer[]; mediaTransport?: string }
  | { type: 'pong'; id: number }
  | { type: 'peer-joined' | 'peer-updated'; peer: Peer }
  | { type: 'peer-left'; peerId: string }
  | { type: 'signal'; from: string; signal: Signal }
  | { type: 'error'; message: string };
export interface OutputDevice { id: string; name: string }
export interface NativeAudio { samples: string | Uint8Array; channels: number; sampleRate: number }
export type CaptureMode = 'endpoint' | 'exclude-self';
export interface DesktopBridge {
  platform: string;
  listOutputDevices(): Promise<{ devices: OutputDevice[]; defaultDeviceId: string }>;
  getCaptureCapabilities?(): Promise<{ processExclusion: boolean; reason?: string }>;
  getCaptureStats?(): Promise<{ delivered: number; dropped: number; pending: number; capacity: number }>;
  beginMicrophoneSession?(deviceId?: string): Promise<void>;
  endMicrophoneSession?(): Promise<void>;
  startCapture(deviceId: string, mode?: CaptureMode): Promise<{ sampleRate: number; channels: number }>;
  stopCapture(): Promise<void>;
  onAudio(callback: (data: NativeAudio) => void): () => void;
  onCaptureError(callback: (message: string) => void): () => void;
}
declare global { interface Window { audioShareDesktop?: DesktopBridge } }
