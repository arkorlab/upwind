/** A scope's URL component, preserving lone surrogates without colliding with ordinary names. */
export function encodedScopeId(scopeId: string): string {
  try {
    return encodeURIComponent(scopeId);
  } catch {
    // JSON preserves lone surrogates; a literal tilde never encodes to this prefix.
    return `%7E${encodeURIComponent(JSON.stringify(scopeId).slice(1, -1))}`;
  }
}
