export const CHAT_TOPIC = 'audioshare.chat.v1';
export interface ChatMessage { id: string; peerId: string; name: string; text: string; sentAt: number; local: boolean }
export interface ChatPayload { id: string; text: string; sentAt: number }
export function chatPayload(value: unknown): ChatPayload | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Partial<ChatPayload>;
  if (typeof v.id !== 'string' || !/^[a-f\d-]{36}$/i.test(v.id) || typeof v.text !== 'string' || !v.text.trim() || v.text.length > 2000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v.text) || typeof v.sentAt !== 'number' || !Number.isSafeInteger(v.sentAt) || v.sentAt < 0) return;
  return { id: v.id, text: v.text, sentAt: v.sentAt };
}
/** Bounded replay and burst protection. Sender identity always comes from the transport. */
export class ChatGuard {
  private ids = new Set<string>();
  private senders = new Map<string, number[]>();
  accept(peerId: string, payload: ChatPayload, now = Date.now()): boolean {
    const key = `${peerId}:${payload.id}`;
    if (this.ids.has(key)) return false;
    const recent = (this.senders.get(peerId) ?? []).filter(time => now - time < 10000);
    if (recent.length >= 10) return false;
    recent.push(now); this.senders.set(peerId, recent); this.ids.add(key);
    if (this.ids.size > 500) this.ids.delete(this.ids.values().next().value!);
    if (this.senders.size > 256) this.senders.delete(this.senders.keys().next().value!);
    return true;
  }
}
