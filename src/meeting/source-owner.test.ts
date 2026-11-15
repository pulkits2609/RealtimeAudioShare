import { expect, it } from 'vitest';
import { sourceOwner } from './source-owner';
it('groups only the exact server-linked companion, never arbitrary metadata identities', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const metadata = JSON.stringify({ managed: true, companion: true, parentIdentity: id, parentName: 'Alice' });
  expect(sourceOwner(`${id}:system`, 'System audio', metadata)).toEqual({ identity: id, name: 'Alice', companion: true });
  for (const identity of ['attacker', `${id}:other`, id]) expect(sourceOwner(identity, 'Original', metadata).identity).toBe(identity);
  expect(sourceOwner(`${id}:system`, 'Original', '{broken')).toEqual({ identity: `${id}:system`, name: 'Original', companion: false });
});
