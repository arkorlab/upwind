import { encodeUtf8, fromBase64Url, toBase64Url } from '@stayingupwind/core/util';

/**
 * The capability an application's Worker holds to speak to the cache gateway: a statement, signed
 * with a key only the gateway holds, that a scope is the one it may write. It is derived from the
 * scope, so the gateway verifies it by recomputation and keeps no table of tokens; and it names
 * only that scope, so a token that leaks from one deployment's isolate can touch nothing else —
 * which is what that isolate's own code could do anyway.
 */

/**
 * What a host names its cache by. `tokenLabel` is signed into every token beside the scope, so a
 * key shared with anything else that signs cannot be made to vouch for a scope; it is the host's
 * own, and fixed for good once a token signed over it is in a deployment.
 */
export interface CacheNaming {
  readonly tokenLabel: string;
}

const TOKEN_VERSION = 'v1';
const SEPARATOR = '.';
/** What joins the fields a token signs (`message`). */
const FIELD_SEPARATOR = '|';
/**
 * A scope id a token can be signed for: one that carries neither separator. A scope's schema holds
 * its id to it (`cacheScopeSchema`), so a scope no token could open is refused where it is made.
 */
export const SIGNABLE_SCOPE_ID = /^[^.|]+$/u;
const HMAC = { name: 'HMAC', hash: 'SHA-256' } as const;
const PARTS = 3;

function keyMaterial(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encodeUtf8(text));
}

function importKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', keyMaterial(secret), HMAC, false, [usage]);
}

/**
 * The bytes a token signs: the host's label, the version, the scope. Neither the label nor the scope
 * may carry the separator, or two pairs of them could come to the same bytes — a label `a` with a
 * scope `b|v1|c`, and a label `a|v1|b` with a scope `c` — and a signature one host made would vouch
 * for a scope under another sharing its key. `undefined` for such a pair, which nothing signs and
 * nothing verifies.
 */
function message(scopeId: string, naming: CacheNaming): Uint8Array<ArrayBuffer> | undefined {
  if (naming.tokenLabel.includes(FIELD_SEPARATOR) || scopeId.includes(FIELD_SEPARATOR)) {
    return undefined;
  }
  return keyMaterial(
    `${naming.tokenLabel}${FIELD_SEPARATOR}${TOKEN_VERSION}${FIELD_SEPARATOR}${scopeId}`,
  );
}

/** `v1.<scopeId>.<base64url signature>` */
export async function signCacheToken(
  secret: string,
  scopeId: string,
  naming: CacheNaming,
): Promise<string> {
  if (scopeId === '' || scopeId.includes(SEPARATOR)) {
    throw new Error('a scope id cannot carry the token separator');
  }
  const signed = message(scopeId, naming);
  if (signed === undefined) {
    throw new Error(`neither a token label nor a scope id may carry ${FIELD_SEPARATOR}`);
  }
  const key = await importKey(secret, 'sign');
  const signature = await crypto.subtle.sign(HMAC, key, signed);
  return [TOKEN_VERSION, scopeId, toBase64Url(new Uint8Array(signature))].join(SEPARATOR);
}

export interface ParsedCacheToken {
  readonly scopeId: string;
  readonly signature: Uint8Array;
}

/** The scope a token claims, or `undefined` when it is malformed. Does not check the signature. */
export function parseCacheToken(token: string): ParsedCacheToken | undefined {
  const parts = token.split(SEPARATOR);
  if (parts.length !== PARTS) {
    return undefined;
  }
  const [version, scopeId, encoded] = parts;
  if (
    version !== TOKEN_VERSION ||
    scopeId === undefined ||
    scopeId === '' ||
    encoded === undefined
  ) {
    return undefined;
  }
  let signature: Uint8Array;
  try {
    signature = fromBase64Url(encoded);
  } catch {
    return undefined;
  }
  return signature.byteLength === 0 ? undefined : { scopeId, signature };
}

export interface VerifyCacheTokenInput {
  readonly token: string;
  /** The scope the request names; the token must name the same one. */
  readonly scopeId: string;
  readonly secret: string;
  /** The key before a rotation, accepted until every live deployment carries a new token. */
  readonly previousSecret?: string | undefined;
  /** What the host signs its tokens over (`signCacheToken`). */
  readonly naming: CacheNaming;
}

async function verifyWith(
  secret: string,
  signed: Uint8Array<ArrayBuffer>,
  signature: Uint8Array,
): Promise<boolean> {
  const key = await importKey(secret, 'verify');
  return crypto.subtle.verify(HMAC, key, new Uint8Array(signature), signed);
}

/** Whether `token` lets its bearer act on `scopeId`; WebCrypto's comparison, no oracle. */
export async function verifyCacheToken(input: VerifyCacheTokenInput): Promise<boolean> {
  const parsed = parseCacheToken(input.token);
  if (parsed?.scopeId !== input.scopeId) {
    return false;
  }
  const signed = message(input.scopeId, input.naming);
  if (signed === undefined) {
    return false;
  }
  if (await verifyWith(input.secret, signed, parsed.signature)) {
    return true;
  }
  return (
    input.previousSecret !== undefined && verifyWith(input.previousSecret, signed, parsed.signature)
  );
}
