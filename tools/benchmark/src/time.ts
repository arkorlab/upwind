/* eslint-disable unicorn/prefer-temporal -- The pinned Node 24 runtime does not provide Temporal. */

export function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeIso(value: string): string {
  return new Date(value).toISOString();
}

export function parseIso(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || normalizeIso(value) !== value) {
    throw new Error('expected an ISO UTC timestamp');
  }
  return value;
}
