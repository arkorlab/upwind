// The delegated fetcher replaces this virtual origin with the sealed broker origin.
const ENDPOINT = 'https://oidc.upwind.internal/v1/token';
const MAX_REQUEST_BYTES = 2048;
const MAX_RESPONSE_BYTES = 16_384;
const INVALID_RESPONSE = 'invalid Node OIDC capability response';
const TOKEN_RESULT_FIELDS = 3;
const HTTP_OK = 200;
const REFUSALS: ReadonlySet<string> = new Set([
  'invalid_audience',
  'invalid_identity',
  'rate_limited',
  'unavailable',
]);

export interface NodeOidcOptions {
  readonly audience?: string;
}
export type NodeOidcResult =
  | { readonly ok: true; readonly token: string; readonly expiresAt: number }
  | { readonly ok: false; readonly reason: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function optionsBody(value: unknown): string | undefined {
  if (value === undefined || value === null) return '{}';
  if (!record(value) || Object.keys(value).some((key) => key !== 'audience')) return undefined;
  const audience = Object.hasOwn(value, 'audience') ? value['audience'] : undefined;
  if (audience === undefined) return '{}';
  if (typeof audience !== 'string' || audience.length === 0) return undefined;
  const body = JSON.stringify({ audience });
  return new TextEncoder().encode(body).byteLength <= MAX_REQUEST_BYTES ? body : undefined;
}
async function responseValue(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error(INVALID_RESPONSE);
  const decoder = new TextDecoder();
  let length = 0;
  let json = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(INVALID_RESPONSE);
      }
      json += decoder.decode(part.value, { stream: true });
    }
    try {
      const value: unknown = JSON.parse(json + decoder.decode());
      return value;
    } catch {
      throw new Error(INVALID_RESPONSE);
    }
  } finally {
    reader.releaseLock();
  }
}
function resultOf(value: unknown): NodeOidcResult {
  if (!record(value)) throw new Error(INVALID_RESPONSE);
  if (
    value['ok'] === true &&
    Object.keys(value).length === TOKEN_RESULT_FIELDS &&
    typeof value['token'] === 'string' &&
    value['token'].length > 0 &&
    typeof value['expiresAt'] === 'number' &&
    Number.isSafeInteger(value['expiresAt']) &&
    value['expiresAt'] > 0
  )
    return { ok: true, token: value['token'], expiresAt: value['expiresAt'] };
  if (
    value['ok'] === false &&
    Object.keys(value).length === 2 &&
    typeof value['reason'] === 'string' &&
    REFUSALS.has(value['reason'])
  )
    return { ok: false, reason: value['reason'] };
  throw new Error(INVALID_RESPONSE);
}

/** Only audience crosses HTTP; the Worker issuer retains its sealed identity and RPC binding. */
export function nodeOidcCapability(transport: { readonly fetch: typeof fetch }): {
  readonly token: (options?: NodeOidcOptions) => Promise<NodeOidcResult>;
} {
  return Object.freeze({
    token: async (options?: NodeOidcOptions): Promise<NodeOidcResult> => {
      const body = optionsBody(options);
      if (body === undefined) return { ok: false, reason: 'invalid_audience' };
      const response = await transport.fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        cache: 'no-store',
        redirect: 'manual',
      });
      if (response.status !== HTTP_OK) {
        await response.body?.cancel();
        throw new Error('Node OIDC capability unavailable');
      }
      return resultOf(await responseValue(response));
    },
  });
}
