import { describe, expect, it } from 'vitest';
import { chatPayload, ChatGuard } from './chat';
const payload = { id: '12345678-1234-1234-1234-123456789abc', text: 'Hello 👋', sentAt: 1000 };
describe('room chat boundaries', () => {
  it('accepts text while rejecting empty, oversized, malformed and control data', () => {
    expect(chatPayload(payload)).toEqual(payload);
    for (const value of [null, {}, { ...payload, text: '' }, { ...payload, text: ' '.repeat(20) }, { ...payload, text: 'x'.repeat(2001) }, { ...payload, text: '\0' }, { ...payload, id: 'spoof' }, { ...payload, sentAt: Infinity }]) expect(chatPayload(value)).toBeUndefined();
    expect(chatPayload({ ...payload, text: '<script>alert(1)</script>' })?.text).toBe('<script>alert(1)</script>');
  });
  it('rejects replay and bursts without letting payloads select a sender', () => {
    const guard = new ChatGuard();
    expect(guard.accept('alice', payload, 1000)).toBe(true);
    expect(guard.accept('alice', payload, 1001)).toBe(false);
    expect(guard.accept('bob', payload, 1001)).toBe(true);
    for (let i = 0; i < 9; i++) expect(guard.accept('alice', { ...payload, id: String(i) }, 1002)).toBe(true);
    expect(guard.accept('alice', { ...payload, id: 'overflow' }, 1003)).toBe(false);
    expect(guard.accept('alice', { ...payload, id: 'recovered' }, 11003)).toBe(true);
  });
});
