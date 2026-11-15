import { describe, it, expect } from 'vitest';
import { defaultConnectionPort, musicSdp, serverUrl } from './protocol';
describe('connection address', () => {
  it('keeps public frontend 9998 separate from API 9999 and preserves HTTPS gateways', () => {
    expect(defaultConnectionPort('https:', '9998', false)).toBe('9999');
    expect(defaultConnectionPort('https:', '9443', false)).toBe('9443');
    expect(defaultConnectionPort('https:', '', false)).toBe('443');
    expect(defaultConnectionPort('http:', '1420', true)).toBe('9999');
  });
  it('accepts hostnames and IPv6 with explicit security', () => {
    expect(serverUrl('localhost', '8787', false)).toBe('ws://localhost:8787/');
    expect(serverUrl('::1', '443', true)).toBe('wss://[::1]/');
  });
  it('rejects URL paths, credentials and invalid ports', () => {
    for (const host of ['https://example.com', 'a/b', 'x@y', '']) expect(() => serverUrl(host, '8787', false)).toThrow();
    for (const port of ['0', '65536', '-1', '1.5', '']) expect(() => serverUrl('localhost', port, false)).toThrow();
  });
});
describe('Opus negotiation', () => {
  it('preserves unrelated SDP and parameters without duplicating stereo', () => {
    const original = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;stereo=0\r\na=sendrecv\r\n';
    const sdp = musicSdp(original);
    expect(sdp).toContain('minptime=10;stereo=1;sprop-stereo=1;maxaveragebitrate=510000;useinbandfec=1;usedtx=0\r\n');
    expect(musicSdp(sdp)).toBe(sdp);
    expect(sdp).toContain('a=sendrecv\r\n');
  });
  it('adds missing fmtp and leaves non-Opus SDP alone', () => {
    expect(musicSdp('a=rtpmap:109 opus/48000/2\r\n')).toContain('a=fmtp:109 stereo=1');
    expect(musicSdp('v=0\r\n')).toBe('v=0\r\n');
  });
  it('configures every audio section in a multi-transceiver session', () => {
    const section = 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10\r\n';
    expect(musicSdp('v=0\r\n' + section + section).match(/stereo=1;sprop-stereo=1/g)).toHaveLength(2);
  });
});
