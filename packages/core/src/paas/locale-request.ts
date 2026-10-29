import { decodeUtf8, encodeUtf8, fromBase64Url, toBase64Url } from '../util/bytes.ts';

/** Only the original inputs to locale negotiation, never the request's other cookies. */
export interface LocaleRequest {
  readonly language: string | null;
  readonly cookie: string | null;
}

const LOCALE_COOKIE = 'NEXT_LOCALE';
const COOKIE_PREFIX = `${LOCALE_COOKIE}=`;
const INVALID_HEADER_VALUE = /[\r\n\0]/u;

/** The cookie parser keeps the first syntactically valid pair, including an empty value. */
function localeCookie(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at !== -1 && part.slice(0, at).trim() === LOCALE_COOKIE) {
      return `${COOKIE_PREFIX}${part.slice(at + 1).trim()}`;
    }
  }
  return null;
}

/** Capture before middleware overrides headers; null explicitly records original absence. */
export function localeRequestOf(headers: Headers): LocaleRequest {
  return { language: headers.get('accept-language'), cookie: localeCookie(headers.get('cookie')) };
}

export function encodeLocaleRequest(request: LocaleRequest): string {
  return toBase64Url(encodeUtf8(JSON.stringify(request)));
}

function isHeaderValue(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && !INVALID_HEADER_VALUE.test(value));
}

/** A strict, minimal projection: no other cookie or field can be carried by this protocol. */
export function decodeLocaleRequest(value: string): LocaleRequest | undefined {
  try {
    const parsed: unknown = JSON.parse(decodeUtf8(fromBase64Url(value)));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const fields = parsed as Record<string, unknown>;
    const language = fields['language'];
    const cookie = fields['cookie'];
    if (
      Object.keys(fields).length !== 2 ||
      !isHeaderValue(language) ||
      !isHeaderValue(cookie) ||
      (cookie !== null && (!cookie.startsWith(COOKIE_PREFIX) || cookie.includes(';')))
    )
      return undefined;
    return { language, cookie };
  } catch {
    return undefined;
  }
}
