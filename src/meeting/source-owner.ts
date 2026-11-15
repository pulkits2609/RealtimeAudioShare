/** Presentation grouping only; authorization remains entirely server-side. */
export function sourceOwner(identity: string, name: string, metadata?: string): { identity: string; name: string; companion: boolean } {
  try {
    const value = JSON.parse(metadata || '{}');
    if (value.managed === true && value.companion === true && typeof value.parentIdentity === 'string' &&
      /^[a-f\d-]{36}$/i.test(value.parentIdentity) && identity === `${value.parentIdentity}:system`) {
      return { identity: value.parentIdentity, name: typeof value.parentName === 'string' && value.parentName.length <= 40 ? value.parentName : name, companion: true };
    }
  } catch { /* Unrecognized metadata never changes sender ownership. */ }
  return { identity, name, companion: false };
}
