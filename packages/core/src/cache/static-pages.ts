import { SHARED_CACHE_CONTROL_HEADERS } from '../request/constants.ts';
import { rendersInline } from '../request/headers.ts';

const HTML_TYPE = 'text/html';
const CACHE_CONTROL = 'cache-control';
const CSP = 'content-security-policy';
const CSP_REPORT_ONLY = 'content-security-policy-report-only';
const VETO_FIELDS: ReadonlySet<string> = new Set([
  'clear-site-data',
  'content-range',
  'location',
  'refresh',
  'set-cookie',
]);
const PRIVATE_FIELDS: ReadonlySet<string> = new Set([
  ...VETO_FIELDS,
  CACHE_CONTROL,
  'content-encoding',
  'content-type',
  CSP,
  CSP_REPORT_ONLY,
  'vary',
  ...SHARED_CACHE_CONTROL_HEADERS,
]);

function policyVeto(name: string, lower: string): boolean {
  if (name === CACHE_CONTROL || SHARED_CACHE_CONTROL_HEADERS.includes(name)) {
    return lower
      .split(',')
      .some((part) => ['no-store', 'private'].includes(part.trim().split('=', 1)[0]?.trim() ?? ''));
  }
  if (name === CSP || name === CSP_REPORT_ONLY) return lower.includes("'nonce-");
  return name === 'connection' && lower.split(',').some((part) => PRIVATE_FIELDS.has(part.trim()));
}

function representationVeto(name: string, value: string): boolean {
  const lower = value.toLowerCase();
  if (name === 'content-type') return lower.split(';', 1)[0]?.trim() !== HTML_TYPE;
  if (name === 'content-encoding') return lower.trim() !== 'identity';
  if (name === 'content-disposition') return !rendersInline(value);
  return (
    name === 'vary' &&
    lower.split(',').some((part) => part.trim() !== '' && part.trim() !== 'accept-encoding')
  );
}

/** Privacy vetoes are checked before storage filters can hide their original presence. */
export function staticPageHeadersAllowSharing(headers: Iterable<[string, string]>): boolean {
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (
      VETO_FIELDS.has(name) ||
      policyVeto(name, value.toLowerCase()) ||
      representationVeto(name, value)
    )
      return false;
  }
  return true;
}

/** A transform prohibition survives targeted CDN policy filtering; no freshness is copied. */
export function staticPageHasNoTransform(headers: Iterable<[string, string]>): boolean {
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (
      (name === CACHE_CONTROL || SHARED_CACHE_CONTROL_HEADERS.includes(name)) &&
      value
        .toLowerCase()
        .split(',')
        .some((part) => part.trim().split('=', 1)[0]?.trim() === 'no-transform')
    )
      return true;
  }
  return false;
}
