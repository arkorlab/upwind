/**
 * The authorization code the stand-in provider issues, and how it is read back.
 *
 * An OAuth authorization code is a short-lived bearer of an identity. This one never leaves the
 * machine that made it — it is minted by an endpoint of this application's and exchanged by the same
 * application a moment later — so it could have been a number in a map. It is signed instead, for
 * two reasons: a signed code needs no state kept anywhere, which is what lets the exchange work
 * across a dev-server restart; and a credential that is *not* signed is the kind of thing that gets
 * copied into a codebase where it does leave the machine.
 *
 * HMAC-SHA256 over the payload, with the same secret the rest of the session machinery uses, through
 * `crypto.subtle` — which is the one cryptography implementation present in a browser, in Node and
 * in workerd alike, so nothing here has a runtime of its own. Verification is `subtle.verify` rather
 * than a comparison of two strings, so the check does not depend on the two being compared carefully.
 *
 * There is no expiry. What bounds this code's usefulness is the flow it belongs to: Better Auth
 * matches the `state` it stored in a cookie before the code is ever looked at, and a code without
 * that state is exchanged for nothing.
 */

/** Who the code says you are. Whatever this holds is what the application sees as the user. */
export interface Identity {
  readonly email: string;
  readonly name: string;
  /** The provider the stand-in was answering for, kept so a code cannot be replayed at another. */
  readonly provider: string;
}

const ALGORITHM = { name: 'HMAC', hash: 'SHA-256' } as const;
/** `payload.signature`, which is one separator that appears in neither half. */
const SEPARATOR = '.';
/** How many base64 characters encode three bytes, and so how long a padded group is. */
const BASE64_GROUP = 4;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * The bytes back, or nothing for text that is not base64url — which is every tampered code.
 *
 * The buffer is spelled out in the type because `crypto.subtle` takes a `BufferSource`, and a
 * `Uint8Array` over an unknown buffer kind is not one: a view that might be over shared memory is
 * not something the Web Crypto types accept, and `Uint8Array.from` promises no more than that.
 */
function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  const standard = text.replaceAll('-', '+').replaceAll('_', '/');
  const remainder = standard.length % BASE64_GROUP;
  const padded = remainder === 0 ? standard : `${standard}${'='.repeat(BASE64_GROUP - remainder)}`;
  try {
    return Uint8Array.from(atob(padded), (character) => character.codePointAt(0) ?? 0);
  } catch {
    return undefined;
  }
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), ALGORITHM, false, [
    'sign',
    'verify',
  ]);
}

/** A code carrying this identity, signed with this secret. */
export async function signCode(secret: string, identity: Identity): Promise<string> {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(identity)));
  const key = await signingKey(secret);
  const signature = await crypto.subtle.sign(ALGORITHM, key, new TextEncoder().encode(payload));
  return `${payload}${SEPARATOR}${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * The identity a code carries, or nothing for a code that is not one of ours — unsigned, signed with
 * another key, altered since, or shaped like something else entirely.
 *
 * One answer for every way of being wrong, on purpose: the caller has the same thing to do in each
 * case, and a message distinguishing them would only describe this application's key material to
 * whoever was guessing at it.
 */
export async function readCode(secret: string, code: string): Promise<Identity | undefined> {
  const separator = code.lastIndexOf(SEPARATOR);
  if (separator <= 0) {
    return undefined;
  }
  const payload = code.slice(0, separator);
  const signature = fromBase64Url(code.slice(separator + 1));
  if (signature === undefined) {
    return undefined;
  }
  const key = await signingKey(secret);
  const signed = await crypto.subtle.verify(
    ALGORITHM,
    key,
    signature,
    new TextEncoder().encode(payload),
  );
  if (!signed) {
    return undefined;
  }
  const bytes = fromBase64Url(payload);
  if (bytes === undefined) {
    return undefined;
  }
  try {
    const read = JSON.parse(new TextDecoder().decode(bytes)) as Partial<Identity>;
    const { email, name, provider } = read;
    if (typeof email !== 'string' || typeof name !== 'string' || typeof provider !== 'string') {
      return undefined;
    }
    return { email, name, provider };
  } catch {
    return undefined;
  }
}
