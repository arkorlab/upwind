/**
 * Native Next.js can stamp cache entries with timeOrigin + performance.now(), which includes a
 * fractional millisecond. The shared cache wire format uses integer Unix milliseconds. Round
 * down so a value never appears newer than an invalidation that actually followed its production.
 */
export function unixMilliseconds(value: number): number {
  const rounded = Math.floor(value);
  if (!Number.isSafeInteger(rounded) || rounded < 0) {
    throw new Error('native cache timestamp must be a nonnegative Unix millisecond value');
  }
  return rounded;
}
