export interface AccessSession { accessToken: string; identity: string; name: string; owner: boolean; expiresAt: number }
export interface ManagedRoom { name: string; role: 'owner' | 'moderator' | 'participant' | 'viewer'; locked: boolean; sharingAllowed: boolean }
export function apiBase(url: string) { const result = new URL(url); result.protocol = ['wss:', 'https:'].includes(result.protocol) ? 'https:' : 'http:'; result.pathname = '/'; result.search = ''; result.hash = ''; return result; }
export async function accessRequest<T>(base: string, path: string, session?: AccessSession | null, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(new URL(path, apiBase(base)), { method: method || (body === undefined ? 'GET' : 'POST'), credentials: 'omit', redirect: 'error',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Room service returned ${response.status}`);
  return result as T;
}
export async function loginIfManaged(base: string, name: string, token: string): Promise<AccessSession | null> {
  const response = await fetch(new URL('/v1/auth/status', apiBase(base)), { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Could not check server access mode.');
  const status = await response.json();
  return status.enabled ? accessRequest<AccessSession>(base, '/v1/auth/session', null, { name, token }) : null;
}
