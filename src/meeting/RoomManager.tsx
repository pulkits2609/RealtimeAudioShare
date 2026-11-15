import { useEffect, useRef, useState } from 'react';
import { accessRequest, type AccessSession, type ManagedRoom } from './room-access';
import { InvitationHistory } from './InvitationHistory';

interface Member {
  identity: string;
  name: string;
  role: string;
  connected?: boolean;
  presenceKnown?: boolean;
}

interface RoomManagerProps {
  base: string;
  session: AccessSession | null;
  active?: boolean;
  liveRoom?: string;
  livePeerIds?: readonly string[];
  onSelect(name: string): void;
  onLogout(): void;
}

const path = (room: string) => `/v1/rooms/${encodeURIComponent(room)}`;
const refreshIntervalMs = 12000;

export function RoomManager({ base, session, active = true, liveRoom, livePeerIds = [], onSelect, onLogout }: RoomManagerProps) {
  const [rooms, setRooms] = useState<ManagedRoom[]>([]), [name, setName] = useState('');
  const [error, setError] = useState(''), [invite, setInvite] = useState(''), [busy, setBusy] = useState(false);
  const [role, setRole] = useState('participant');
  const [inviteRoom, setInviteRoom] = useState('');
  const [maxUses, setMaxUses] = useState('1'), [tokenCount, setTokenCount] = useState('1');
  const [batchTokens, setBatchTokens] = useState<string[]>([]), [createdUses, setCreatedUses] = useState(1);
  const [createdRecords, setCreatedRecords] = useState<string[]>([]);
  const [historyRoom, setHistoryRoom] = useState(''), [historyRevision, setHistoryRevision] = useState(0);
  const validInviteOptions = Number.isInteger(Number(maxUses)) && Number(maxUses) >= 1 && Number(maxUses) <= 100 && Number.isInteger(Number(tokenCount)) && Number(tokenCount) >= 1 && Number(tokenCount) <= 20;
  const [members, setMembers] = useState<Member[]>([]);
  const [selected, setSelected] = useState('');
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [refreshError, setRefreshError] = useState('');
  const actionInFlight = useRef(false);
  const liveIdentities = new Set(livePeerIds);
  const liveRevision = JSON.stringify([...liveIdentities].sort());
  const memberPresenceRevision = liveRoom === selected ? liveRevision : '';

  async function action(operation: () => Promise<unknown>) {
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
      // A media cleanup error can be returned after room access was saved.
      setRefreshRevision(value => value + 1);
    }
  }

  useEffect(() => {
    if (!session || !active || busy) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const canApply = () => current && !actionInFlight.current;
    async function update() {
      try {
        const result = await accessRequest<{ rooms: ManagedRoom[] } | ManagedRoom[]>(base, '/v1/rooms', session);
        if (!canApply()) return;
        const updatedRooms = Array.isArray(result) ? result : result.rooms;
        setRooms(updatedRooms);
        const manageable = (roomName: string) => updatedRooms.some(room => room.name === roomName && (room.role === 'owner' || room.role === 'moderator'));
        if (selected && manageable(selected)) {
          const result = await accessRequest<{ members: Member[]; presenceKnown?: boolean } | Member[]>(base, path(selected) + '/members', session);
          if (!canApply()) return;
          setMembers(Array.isArray(result) ? result : result.members.map(member => ({ ...member, presenceKnown: member.presenceKnown ?? result.presenceKnown })));
        } else if (selected) {
          setSelected('');
          setMembers([]);
        }
        setHistoryRoom(room => room && !manageable(room) ? '' : room);
        setRefreshError('');
      } catch (error) {
        if (canApply()) setRefreshError(error instanceof Error ? error.message : String(error));
      } finally {
        if (current) timer = setTimeout(() => { void update(); }, refreshIntervalMs);
      }
    }
    timer = setTimeout(() => { void update(); }, 150);
    return () => { current = false; clearTimeout(timer); };
  }, [base, session, active, busy, selected, liveRoom, memberPresenceRevision, refreshRevision]);

  if (!session) return <section className="card room-manager"><h2>Rooms & access</h2><p>This server uses shared-token access. Choose a room name in Connection. Enable managed access on the upgraded server to create private rooms, invitations and moderator controls.</p></section>;

  function memberStatus(member: Member) {
    const known = liveRoom === selected || member.presenceKnown === true;
    const connected = liveRoom === selected ? member.identity === session?.identity || liveIdentities.has(member.identity) : member.connected;
    return !known ? 'Live connection status unavailable' : connected ? 'Connected to this room' : 'Not connected · room access only';
  }
  return <section className="card room-manager" aria-label="Room management"><h2>Rooms & access</h2><p>Signed in as {session.name} · {session.owner ? 'server owner' : 'invited participant'}. Invitations are scoped to a room, expire, and have the usage limit you choose.</p>
    {(error || refreshError) && <p role="alert">{error || refreshError}</p>}
    <div className="room-tools"><button className="button secondary" disabled={busy} onClick={() => setRefreshRevision(value => value + 1)}>Refresh rooms</button><button className="button secondary" disabled={busy} onClick={() => { void action(async () => { await accessRequest(base, '/v1/auth/logout', session, {}); onLogout(); }); }}>Sign out</button></div>
    {session.owner && <form className="room-tools" onSubmit={event => { event.preventDefault(); void action(async () => { await accessRequest(base, '/v1/rooms', session, { name }); setName(''); }); }}><label>New room<input value={name} onChange={event => setName(event.target.value)} maxLength={64} pattern="[A-Za-z0-9_-]{1,64}" required/></label><button className="button primary" disabled={busy}>Create room</button></form>}
    <label>Invitation role<select value={role} onChange={event => setRole(event.target.value)}><option value="participant">Participant</option><option value="viewer">Viewer</option>{session.owner && <option value="moderator">Moderator</option>}</select></label>
    <div className="invitation-options"><label htmlFor="invite-count">Number of tokens<input id="invite-count" type="number" min="1" max="20" step="1" value={tokenCount} disabled={busy} onChange={event => setTokenCount(event.target.value)}/></label><label htmlFor="invite-uses">Uses per token<input id="invite-uses" type="number" min="1" max="100" step="1" value={maxUses} disabled={busy} onChange={event => setMaxUses(event.target.value)}/></label><p>Expiry: 1 hour. One use means one successful sign-in; reconnecting the same session does not spend another use.</p></div>
    {rooms.map(room => <div className="room-row" key={room.name}><strong>{room.name}<small> · {room.role}{room.locked ? ' · locked' : ''}{!room.sharingAllowed ? ' · sharing restricted' : ''}</small></strong><button className="button secondary" disabled={busy} onClick={() => onSelect(room.name)}>Select room</button>{['owner', 'moderator'].includes(room.role) && <><button className="text-button" disabled={busy || !validInviteOptions} onClick={() => { setInvite(''); setBatchTokens([]); void action(async () => { const result = await accessRequest<{ token?: string; tokens?: string[]; maxUses?: number; invitations?: { id: string }[] }>(base, path(room.name) + '/invites', session, { role, expiresInSeconds: 3600, maxUses: Number(maxUses), count: Number(tokenCount) }); const tokens = result.tokens || (result.token ? [result.token] : []); setInvite(tokens[0] || ''); setBatchTokens(tokens); setCreatedRecords(result.invitations?.map(value => value.id) || []); setCreatedUses(result.maxUses || 1); setInviteRoom(room.name); setHistoryRoom(room.name); setHistoryRevision(value => value + 1); }); }}>Create invitation</button><button className="text-button" disabled={busy} onClick={() => { setHistoryRoom(room.name); setHistoryRevision(value => value + 1); }}>Token history</button><button className="text-button" disabled={busy} onClick={() => { void action(() => accessRequest(base, path(room.name), session, { locked: !room.locked }, 'PATCH')); }}>{room.locked ? 'Unlock' : 'Lock'}</button><button className="text-button" disabled={busy} onClick={() => { void action(() => accessRequest(base, path(room.name), session, { sharingAllowed: !room.sharingAllowed }, 'PATCH')); }}>{room.sharingAllowed ? 'Restrict sharing' : 'Allow sharing'}</button><button className="text-button" disabled={busy} onClick={() => { if (selected !== room.name) setMembers([]); setSelected(room.name); setRefreshRevision(value => value + 1); }}>Manage people</button><button className="text-button" disabled={busy} onClick={() => { void action(async () => { await accessRequest(base, path(room.name) + '/invites', session, undefined, 'DELETE'); setHistoryRevision(value => value + 1); if (inviteRoom === room.name) { setInvite(''); setBatchTokens([]); } }); }}>Revoke invitations</button>{session.owner && <button className="text-button" disabled={busy} onClick={() => { if (window.confirm(`Delete room ${room.name} and disconnect its participants?`)) void action(async () => { await accessRequest(base, path(room.name), session, undefined, 'DELETE'); if (selected === room.name) { setSelected(''); setMembers([]); } if (historyRoom === room.name) setHistoryRoom(''); if (inviteRoom === room.name) { setInvite(''); setBatchTokens([]); } }); }}>Delete room</button>}</>}</div>)}
    {invite && <div role="status"><label>Invitation token for {inviteRoom}<input readOnly value={invite} onFocus={event => event.target.select()}/></label>{createdRecords[0] && <small>Record: {createdRecords[0]}</small>}{batchTokens.slice(1).map((token, index) => <div key={index}><label>Invitation token {index + 2} for {inviteRoom}<input readOnly value={token} onFocus={event => event.target.select()}/></label>{createdRecords[index + 1] && <small>Record: {createdRecords[index + 1]}</small>}</div>)}<p>{batchTokens.length || 1} token(s) created. Each expires in one hour and allows {createdUses} successful sign-in(s). Copy them now; history does not expose token secrets.</p></div>}
    {historyRoom && <InvitationHistory key={`${historyRoom}:${historyRevision}`} base={base} session={session} room={historyRoom} active={active} presenceRevision={liveRoom === historyRoom ? liveRevision : ''}/>}
    {selected && <section><h3>Room access · {selected}</h3><p>This list includes people with access who may not be connected. Live participants appear in the left sidebar.</p>{members.map(member => <div className="room-row" key={member.identity}><strong>{member.name} · {member.role}<small className="member-presence">{memberStatus(member)}</small></strong>{session.owner && member.role !== 'owner' && member.identity !== session.identity && <select aria-label={`${member.name} role`} value={member.role} disabled={busy} onChange={event => { const nextRole = event.target.value; void action(() => accessRequest(base, path(selected) + '/moderation', session, { action: 'role', identity: member.identity, role: nextRole }).then(() => setMembers(old => old.map(value => value.identity === member.identity ? { ...value, role: nextRole } : value)))); }}><option value="viewer">Viewer</option><option value="participant">Participant</option><option value="moderator">Moderator</option></select>}{member.identity !== session.identity && member.role !== 'owner' && (session.owner || member.role !== 'moderator') && <button className="text-button" disabled={busy} onClick={() => {
        void action(async () => {
          await accessRequest(base, path(selected) + '/moderation', session, { action: 'kick', identity: member.identity });
          setMembers(old => old.filter(value => value.identity !== member.identity));
        });
      }}>Remove</button>}</div>)}</section>}
  </section>;
}
