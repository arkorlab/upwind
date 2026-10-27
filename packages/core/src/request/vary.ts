const VARY_HEADER = 'vary';

/**
 * The response now differs by `header`; say so without repeating what the origin said.
 *
 * `*` is an alternative to a field-name list, not a member of one, so a response that already says it
 * is left alone: adding to it would make a value a shared cache may misparse — and one that already
 * says everything varies has nothing to add.
 */
export function varyOn(headers: Headers, header: string): void {
  const existing = headers.get(VARY_HEADER);
  if (existing === null) {
    headers.set(VARY_HEADER, header);
    return;
  }
  // Compared without case, which is how a field name is read. Every caller here names one in lower
  // case, so this changes nothing any of them does — it keeps the next one from saying a name twice
  // by spelling it the way a header usually is.
  const names = new Set(existing.split(',').map((name) => name.trim().toLowerCase()));
  if (!names.has(header.trim().toLowerCase()) && !names.has('*')) {
    headers.set(VARY_HEADER, `${existing}, ${header}`);
  }
}
