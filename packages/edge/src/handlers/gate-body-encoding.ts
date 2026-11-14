import type { RouteGate } from '@stayingupwind/core/manifest';
import { type BoundedBody, readBoundedBody, releaseStream } from '@stayingupwind/core/util';
import { MAX_GATE_SHELL_BYTES } from '@stayingupwind/host/bindings';

import type { EdgeGates } from '../edge-host.ts';
import { logWarn } from '../observability/logger.ts';
import { decompressLive } from './live-compression.ts';

/** Gate adapters whose Workers Fetcher supplies automatically decoded response bodies. */
const FETCHED_GATES = new WeakSet<EdgeGates>();

const CONTENT_ENCODING = 'content-encoding';
const GATE_STREAM_REASON = 'gate';
/** Bound each compressed input slice so a single high-ratio chunk cannot expand unboundedly. */
const DECODE_INPUT_SLICE_BYTES = 1024;

type NonIdentityCoding = 'br' | 'deflate' | 'gzip';
type SupportedCoding = NonIdentityCoding | 'identity';

/** The SDK's service-binding adapter, whose fetch uses Workers' automatic response-body mode. */
export function fetchedGateBodies(gates: EdgeGates): EdgeGates {
  FETCHED_GATES.add(gates);
  return gates;
}

/** Exact content codings Workers fetch decodes; deflate and coding lists remain raw. */
export function gateBodyDecodedByFetch(gates: EdgeGates | undefined, encoding: string): boolean {
  return (
    gates !== undefined && FETCHED_GATES.has(gates) && (encoding === 'gzip' || encoding === 'br')
  );
}

/** Content codings the nonce path can remove without inspecting or guessing another format. */
function supportedCoding(coding: string): coding is SupportedCoding {
  return coding === 'br' || coding === 'deflate' || coding === 'gzip' || coding === 'identity';
}

/** Feed compressed bytes in small slices so backpressure and byte limits bound each decode step. */
function slicedInput(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let rest: Uint8Array | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (rest === undefined || rest.byteLength === 0) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        rest = value;
      }
      controller.enqueue(rest.subarray(0, DECODE_INPUT_SLICE_BYTES));
      rest = rest.subarray(DECODE_INPUT_SLICE_BYTES);
    },
    cancel(reason: unknown) {
      rest = undefined;
      releaseStream(reader, typeof reason === 'string' ? reason : GATE_STREAM_REASON);
    },
  });
}

export interface DecodeNonceDocumentInput {
  readonly response: Response;
  readonly gate: RouteGate;
  readonly gates: EdgeGates | undefined;
  readonly left: number;
}

/**
 * Decode a single-layer encoded gate HTML document within `MAX_GATE_SHELL_BYTES` and `left` ms so
 * `HTMLRewriter` can rewrite its per-response CSP nonces safely. Multi-layer codings, unsupported
 * codings, oversized decompressed bodies, and stalled/corrupt streams are cancelled and refused.
 */
export async function decodeNonceDocument({
  response,
  gate,
  gates,
  left,
}: DecodeNonceDocumentInput): Promise<Response | undefined> {
  const encoding = response.headers.get(CONTENT_ENCODING);
  if (encoding === null || encoding.trim() === '' || response.body === null) {
    return response;
  }
  const codings: NonIdentityCoding[] = [];
  for (const part of encoding.split(',')) {
    const coding = part.trim().toLowerCase();
    if (!supportedCoding(coding)) {
      releaseStream(response.body, GATE_STREAM_REASON);
      return undefined;
    }
    if (coding !== 'identity') {
      codings.push(coding);
    }
  }
  if (codings.length > 1) {
    releaseStream(response.body, GATE_STREAM_REASON);
    return undefined;
  }
  const [coding] = codings;
  const headers = new Headers(response.headers);
  headers.delete(CONTENT_ENCODING);
  if (coding === undefined) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
      encodeBody: 'automatic',
    });
  }
  // Fetch response bodies carry bytes; the Workers declaration leaves their element type open.
  const raw = response.body as ReadableStream<Uint8Array>;
  const decoded = gateBodyDecodedByFetch(gates, encoding)
    ? raw
    : decompressLive(slicedInput(raw), coding);
  let read: BoundedBody;
  try {
    read = await readBoundedBody(decoded, {
      limit: MAX_GATE_SHELL_BYTES,
      stallMs: left,
      budgetMs: left,
    });
  } catch (error) {
    logWarn('a gate did not answer with its encoded document whole', {
      gate: gate.name,
      route: gate.route,
      detail: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  if (read.kind === 'over-limit') {
    releaseStream(read.body, GATE_STREAM_REASON);
    logWarn('a gate answered with an encoded document larger than a shell may be', {
      gate: gate.name,
      route: gate.route,
    });
    return undefined;
  }
  return new Response(read.bytes, {
    status: response.status,
    statusText: response.statusText,
    headers,
    encodeBody: 'automatic',
  });
}
