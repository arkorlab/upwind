import { CACHE_SCOPE_HEADER, type CacheNaming, verifyCacheToken } from '@stayingupwind/host/cache';

/** Shared by the authority's gateway and the KV-only read gateway. */
export interface TokenKeys {
  readonly CACHE_TOKEN_KEY?: string | undefined;
  readonly CACHE_TOKEN_KEY_PREVIOUS?: string | undefined;
}

/**
 * The scheme a token is presented under, as HTTP names one (RFC 9110, section 11): in any case,
 * and one or more spaces before the token.
 */
const BEARER = /^bearer +/iu;
const MIN_KEY_LENGTH = 32;
/** Tokens one isolate remembers having verified; the one used longest ago is let go first. */
const MAX_VERIFIED_TOKENS = 1024;
/**
 * A token as it is signed (`signCacheToken`): its signature in base64url, unpadded, and nothing
 * else in it. The codec that reads a token takes spaces and padding too, so one signature has any
 * number of spellings: only this one is remembered, or a caller holding one token could fill the
 * table with its spellings and push every other deployment's out.
 */
const AS_SIGNED = /^[^.\s]+\.[^.\s]+\.[\w-]+$/u;

/** A token this isolate verified: the scope it opens, and the keys and label it was verified with. */
interface Verified {
  readonly scopeId: string;
  readonly secret: string;
  readonly previousSecret: string | undefined;
  /** The host's label (`CacheNaming`): a token verified under one label vouches for none other. */
  readonly label: string;
}

/**
 * The tokens this isolate has verified, by token.
 *
 * A token is verified by recomputing its signature — importing the key and an HMAC — and every
 * read a render makes through the gateway carries one, so each of them would pay for both before
 * anything was read. Nothing the answer depends on changes between two requests while the keys stay
 * what they were: the token names its scope, and nothing but a change of key stops it opening that
 * scope. So a token that verified is taken at its word again while the keys in force are the ones
 * it was verified with, and for the scope it names alone. A token that did not verify is not
 * remembered, and pays for its recomputation each time.
 *
 * Requests that arrive together before the first verification lands each verify for themselves. A
 * verification under way is not shared, as a read under way is not: what one request started can
 * end with that request, and a request that joined it would wait on something that never settles.
 * An HMAC each is the price, until the first is remembered.
 */
const verified = new Map<string, Verified>();

function remember(token: string, known: Verified): void {
  verified.delete(token);
  if (verified.size >= MAX_VERIFIED_TOKENS) {
    const oldest = verified.keys().next();
    if (oldest.done !== true) {
      verified.delete(oldest.value);
    }
  }
  verified.set(token, known);
}

/**
 * What this isolate verified of `token` before, if it was under the keys and the label in force
 * now: a token is taken at its word again only for what it was verified with.
 */
function rememberedUnder(
  token: string,
  secret: string,
  previousSecret: string | undefined,
  label: string,
): Verified | undefined {
  const known = verified.get(token);
  return known?.secret === secret &&
    known.previousSecret === previousSecret &&
    known.label === label
    ? known
    : undefined;
}

/** Whether a request's token opens the scope it names, under the keys in force. */
export type TokenCheck = (request: Request, scopeId: string, keys: TokenKeys) => Promise<boolean>;

/**
 * The check of a host's tokens, signed over its own label (`CacheNaming`): made once, with the
 * gateway it guards, and remembering what it verified in the one table this isolate keeps.
 */
export function tokenCheckOf(naming: CacheNaming): TokenCheck {
  return async (request, scopeId, keys) => {
    const header = request.headers.get('authorization') ?? '';
    const scheme = BEARER.exec(header);
    const token = scheme === null ? '' : header.slice(scheme[0].length);
    const secret = keys.CACHE_TOKEN_KEY?.trim();
    const previousKey = keys.CACHE_TOKEN_KEY_PREVIOUS?.trim();
    const claimed = request.headers.get(CACHE_SCOPE_HEADER);
    if (
      scopeId === '' ||
      token === '' ||
      secret === undefined ||
      secret.length < MIN_KEY_LENGTH ||
      (claimed !== null && claimed !== scopeId)
    ) {
      return false;
    }
    const previousSecret =
      previousKey !== undefined && previousKey.length >= MIN_KEY_LENGTH ? previousKey : undefined;
    const asSigned = AS_SIGNED.test(token);
    const label = naming.tokenLabel;
    const known = asSigned ? rememberedUnder(token, secret, previousSecret, label) : undefined;
    if (known !== undefined) {
      if (known.scopeId !== scopeId) {
        // Refused, and not a use: a token sent for a scope it does not open keeps its place.
        return false;
      }
      // Moved to the back, so the tokens in use are the last to go when the table is full.
      remember(token, known);
      return true;
    }
    const valid = await verifyCacheToken({ token, scopeId, secret, previousSecret, naming });
    if (valid && asSigned) {
      remember(token, { scopeId, secret, previousSecret, label });
    }
    return valid;
  };
}
