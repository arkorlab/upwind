import { gateNameSchema } from '@stayingupwind/core/bundle';
import { GATE_HEADER_PREFIX, GATE_URL_HEADER, gateBinding } from '@stayingupwind/host/bindings';

import { requestGate } from './gate-upgrade.ts';
import type { LocalHandler } from './miniflare.ts';
import { GATE_UNREACHABLE_HEADER } from './workers/protocol.ts';

/**
 * The gates a stack's edge asks about a request of a route the build declared one for, each reached
 * at an address of its own rather than as a Worker of the stack: a server on this machine, say, or
 * one a test starts. The edge is bound to each as a deployed edge is, by the gate's name
 * (`gateBinding`), and the binding is answered in Node (`gateForwarder`).
 */

/** A route's gate, as a stack is told where it answers. */
export interface LocalGate {
  /** Where the gate answers: what every request it is asked is sent to, whatever its own URL. */
  readonly url: string;
  /** What every request it is asked carries besides the visitor's headers: its credential, say. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/** What the binding answers where the gate could not be reached, beside saying so. */
const BAD_GATEWAY = 502;
/** Printable ASCII, which a header holds: anything else in what is said of a failure is a `?`. */
function headerSafe(text: string): string {
  return text.replaceAll(/[^\u{20}-\u{7E}]/gu, '?');
}

/**
 * The edge's binding to `gate`, answered in Node: each request it is handed — the visitor's, as the
 * edge hands a gate one — sent on to the gate's own URL over HTTP (`requestGate`), its method and
 * visitor headers unchanged, with the URL the visitor asked for
 * (`GATE_URL_HEADER`), and the gate's own headers besides. What the gate answers is the binding's answer, streamed. A gate that cannot be reached
 * at all is said to be so (`GATE_UNREACHABLE_HEADER`), for the edge Worker to fail the binding with,
 * as a deployed edge's binding fails. One the edge lets go of — its visitor gone, its deadline past
 * — is let go of on the way to the gate as well (`Request.signal`, `nodeService`).
 */
export function gateForwarder(gate: LocalGate): LocalHandler {
  return async (request): Promise<Response> => {
    const headers = new Headers(request.headers);
    // The gate's own address names the host it is asked on; the visitor's is in the URL it is told.
    headers.delete('host');
    if (gate.headers !== undefined) {
      const own = Object.entries(gate.headers);
      for (const [name, value] of own) {
        headers.set(name, value);
      }
    }
    // Last, over anything the gate's own headers say: the URL is what the edge was asked.
    headers.set(GATE_URL_HEADER, request.url);
    try {
      return await requestGate(gate.url, request, headers);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return new Response(null, {
        status: BAD_GATEWAY,
        headers: { [GATE_UNREACHABLE_HEADER]: headerSafe(detail) },
      });
    }
  };
}

/**
 * Whether `url` names an HTTP(S) gate: `localhost:4000` parses as a URL of the scheme
 * `localhost:`, which no HTTP transport takes.
 */
function isHttpUrl(url: string): boolean {
  const protocol = URL.parse(url)?.protocol;
  return protocol === 'http:' || protocol === 'https:';
}

/** Validated configured fields, with later spellings of the same header taking precedence. */
function configuredHeaders(gate: LocalGate): Headers {
  const headers = new Headers();
  if (gate.headers !== undefined) {
    const entries = Object.entries(gate.headers);
    for (const [name, value] of entries) headers.set(name, value);
  }
  return headers;
}

/** A configured field that belongs to the edge's gate protocol instead. */
function reservedHeader(headers: Headers): string | undefined {
  for (const name of headers.keys()) {
    if (name.startsWith(GATE_HEADER_PREFIX)) return name;
  }
  return undefined;
}

/**
 * The edge's bindings to `gates`, each under the name a deployed edge binds it by (`gateBinding`).
 * A name no build could declare or absent from `declared`, an address that is no http(s) URL, or a header of its own the
 * gate protocol's (`GATE_HEADER_PREFIX`), is refused as the stack starts, rather than answered as a
 * gate that is not there — or told another route or URL than the request's — with every request.
 */
export function gateServices(
  gates: Readonly<Record<string, LocalGate>> | undefined,
  declared?: ReadonlySet<string>,
): Record<string, LocalHandler> {
  return Object.fromEntries(
    Object.entries(gates ?? {}).map(([name, gate]) => {
      if (!gateNameSchema.safeParse(name).success) {
        throw new Error(`${name} is no gate's name: a lowercase letter, then a-z, 0-9 or -`);
      }
      if (declared !== undefined && !declared.has(name)) {
        throw new Error(`the gate ${name} is not declared by the loaded build`);
      }
      if (!isHttpUrl(gate.url)) {
        throw new Error(`the gate ${name} is to answer at an http(s) URL, not at ${gate.url}`);
      }
      const address = new URL(gate.url);
      if (address.username !== '' || address.password !== '') {
        throw new Error(`the gate ${name} is to answer at an http(s) URL without credentials`);
      }
      const headers = configuredHeaders(gate);
      const reserved = reservedHeader(headers);
      if (reserved !== undefined) {
        throw new Error(
          `the gate ${name}'s own headers may not set ${reserved}: the edge says what each request it asks of is`,
        );
      }
      return [gateBinding(name), gateForwarder({ ...gate, headers: Object.fromEntries(headers) })];
    }),
  );
}
