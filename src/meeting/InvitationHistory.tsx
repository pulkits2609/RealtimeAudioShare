import { useEffect, useRef, useState } from 'react';
import { accessRequest, type AccessSession } from './room-access';

interface Usage { identity: string; name: string; usedAt: number }
interface Invitation { id: string; role: string; expiresAt: number; maxUses: number; usedCount: number; remainingUses: number; revoked: boolean; history?: Usage[] }
interface Page { invitations: Invitation[]; nextCursor: string | null; total: number; retentionDays: number }

interface InvitationHistoryProps {
  base: string;
  session: AccessSession;
  room: string;
  active: boolean;
  presenceRevision: string;
}

export function InvitationHistory({ base, session, room, active, presenceRevision }: InvitationHistoryProps) {
  const [items, setItems] = useState<Invitation[]>([]), [next, setNext] = useState<string | null>(null);
  const [total, setTotal] = useState(0), [retention, setRetention] = useState(30), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [opened, setOpened] = useState(''), [details, setDetails] = useState<Record<string, Usage[]>>({});
  const pageDepth = useRef(1);
  const openedId = useRef('');
  const actionInFlight = useRef(false);
  const endpoint = `/v1/rooms/${encodeURIComponent(room)}/invites`;
  async function load(cursor?: string) {
    const result = await accessRequest<Page>(base, endpoint + (cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=20` : '?limit=20'), session);
    pageDepth.current = cursor ? pageDepth.current + 1 : 1;
    setItems(old => cursor ? [...old.filter(item => !result.invitations.some(next => next.id === item.id)), ...result.invitations] : result.invitations);
    setNext(result.nextCursor); setTotal(result.total); setRetention(result.retentionDays);
  }
  async function perform(operation: () => Promise<void>) {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  }

  function showUsage(id: string) {
    openedId.current = id;
    setOpened(id);
  }

  useEffect(() => {
    if (!active || busy) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const canApply = () => current && !actionInFlight.current;
    async function update() {
      try {
        const result = await accessRequest<Page>(base, endpoint + '?limit=20', session);
        if (!canApply()) return;
        const retainOlderPages = pageDepth.current > 1;
        setItems(old => retainOlderPages
          ? [...result.invitations, ...old.filter(item => !result.invitations.some(updated => updated.id === item.id))]
          : result.invitations);
        if (!retainOlderPages) setNext(result.nextCursor);
        setTotal(result.total);
        setRetention(result.retentionDays);
        const id = openedId.current;
        if (id) {
          const { invitation } = await accessRequest<{ invitation: Invitation }>(base, `${endpoint}/${encodeURIComponent(id)}`, session);
          if (!canApply() || openedId.current !== id) return;
          setItems(old => old.map(item => item.id === id ? invitation : item));
          setDetails({ [id]: invitation.history || [] });
        }
      } catch (error) {
        if (canApply()) setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (current) timer = setTimeout(() => { void update(); }, 24000);
      }
    }
    timer = setTimeout(() => { void update(); }, 200);
    return () => { current = false; clearTimeout(timer); };
  }, [base, session, endpoint, active, busy, presenceRevision]);
  return <section className="invitation-history" aria-label={`Invitation history for ${room}`}><h3>Invitation history · {room}</h3>
    <p>{total} token records · history kept for {retention} days after expiry. Names are those supplied at sign-in.</p>
    {error && <p role="alert">{error}</p>}
    {!items.length && !error && <p>No invitation records yet.</p>}
    {items.map(item => <article className="invitation-record" key={item.id}><div className="room-row"><strong>Token {item.id.slice(0, 8)}<small className="member-presence">{item.role} · {item.usedCount}/{item.maxUses} uses · {item.revoked ? 'Revoked' : item.expiresAt <= Date.now() ? 'Expired' : item.remainingUses === 0 ? 'Fully used' : `${item.remainingUses} uses left`}</small></strong><time>{new Date(item.expiresAt).toLocaleString()}</time>
      <button className="text-button" disabled={busy} aria-expanded={opened === item.id} onClick={() => { if (opened === item.id) { showUsage(''); return; }
        void perform(async () => {
          const { invitation } = await accessRequest<{ invitation: Invitation }>(base, `${endpoint}/${encodeURIComponent(item.id)}`, session);
          setDetails({ [item.id]: invitation.history || [] });
          setItems(old => old.map(value => value.id === item.id ? invitation : value));
          showUsage(item.id);
        }); }}>View usage</button>
      {!item.revoked && <button className="text-button" disabled={busy} onClick={() => { void perform(async () => { await accessRequest(base, `${endpoint}/${encodeURIComponent(item.id)}`, session, undefined, 'DELETE'); setItems(old => old.map(value => value.id === item.id ? { ...value, revoked: true } : value)); }); }}>Revoke token</button>}</div>
      {opened === item.id && <div className="usage-list">{details[item.id]?.length ? <ul>{details[item.id].map((usage, index) => <li key={`${usage.identity}:${index}`}><strong>{usage.name}</strong><time>{new Date(usage.usedAt).toLocaleString()}</time></li>)}</ul> : <p>No successful sign-ins recorded.</p>}</div>}
    </article>)}
    <div className="room-tools"><button className="button secondary" disabled={busy} onClick={() => { void perform(async () => { setDetails({}); showUsage(''); await load(); }); }}>Refresh invitation history</button>{next && <button className="button secondary" disabled={busy} onClick={() => { void perform(() => load(next)); }}>Load more tokens</button>}</div>
  </section>;
}
