/** The optional public frontend port is separate from the public API port. */
export function defaultConnectionPort(protocol: string, port: string, desktop: boolean): string {
  if (desktop || protocol !== 'https:') return '9999';
  return port === '9998' ? '9999' : port || '443';
}

export function serverUrl(host: string, port: string, secure: boolean): string {
  const trimmed = host.trim();
  if (!trimmed || /[\s/?#@]/.test(trimmed) || trimmed.includes('://')) throw new Error('Enter a hostname or IP address, without a protocol or path.');
  const n = Number(port);
  if (!/^\d+$/.test(port) || !Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Port must be between 1 and 65535.');
  const address = trimmed.includes(':') && !trimmed.startsWith('[') ? `[${trimmed}]` : trimmed;
  try { return new URL(`${secure ? 'wss' : 'ws'}://${address}:${n}`).href; }
  catch { throw new Error('Enter a valid server hostname or IP address.'); }
}

// RFC 7587: negotiate full-band stereo; these are requested maxima, not quality guarantees.
export function musicSdp(sdp: string): string {
  return sdp.split(/(?=^m=)/m).map(musicSection).join('');
}
function musicSection(sdp: string): string {
  const opus = sdp.match(/^a=rtpmap:(\d+) opus\/48000\/2\r?$/mi)?.[1];
  if (!opus) return sdp;
  const settings: Record<string, string> = { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: '510000', useinbandfec: '1', usedtx: '0' };
  const pattern = new RegExp(`^a=fmtp:${opus} (.*)\\r?$`, 'm');
  const previous = sdp.match(pattern)?.[1];
  const params = new Map((previous ?? '').trim().split(';').filter(Boolean).map(p => { const [k, ...v] = p.trim().split('='); return [k, v.join('=')]; }));
  for (const [key, value] of Object.entries(settings)) params.set(key, value);
  const line = `a=fmtp:${opus} ${[...params].map(([k, v]) => `${k}=${v}`).join(';')}`;
  return previous !== undefined ? sdp.replace(pattern, line + '\r') : sdp.replace(new RegExp(`(a=rtpmap:${opus} [^\\r\\n]+\\r?\\n)`), `$1${line}\r\n`);
}
