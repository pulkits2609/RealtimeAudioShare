export type ConnectionState = 'offline' | 'connecting' | 'connected' | 'reconnecting';

export function ConnectionStatus({ state, elapsed = 0 }: { state: ConnectionState; elapsed?: number }) {
  const label = { offline: 'Not connected', connecting: 'Connecting to server…', connected: 'Connected', reconnecting: 'Reconnecting…' }[state];
  const seconds = Math.floor(elapsed / 1000);
  const duration = `${Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)}:` : ''}${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return <div className={`connection-status ${state}`}>
    <span className="connection-state" role="status"><span className="connection-indicator" aria-hidden="true"/>{label}</span>
    {(state === 'connected' || state === 'reconnecting') && <span className="call-duration" aria-label={`Connected duration ${duration}`}>{duration}{state === 'reconnecting' && <span className="sr-only">, paused while reconnecting</span>}</span>}
  </div>;
}
