import type { RouteGate } from '@stayingupwind/core/manifest';
import { releaseStream } from '@stayingupwind/core/util';
import { MAX_GATE_SHELL_BYTES } from '@stayingupwind/host/bindings';

import type { EdgeGates } from '../edge-host.ts';
import { logWarn } from '../observability/logger.ts';
import { decompressLive } from './live-compression.ts';

/** Gate adapters whose Workers Fetcher supplies automatically decoded response bodies. */
const FETCHED_GATES = new WeakSet<EdgeGates>();

const CONTENT_ENCODING = 'content-encoding';
const CONTENT_LENGTH = 'content-length';
const GATE_STREAM_REASON = 'gate';
const BUDGET_EXHAUSTED_DETAIL = 'gate document decode budget exhausted';
const OVERSIZED_LOG = 'a gate answered with an encoded document larger than a shell may be';
const INCOMPLETE_LOG = 'a gate did not answer with its encoded document whole';
/**
 * Bound each compressed input slice so a single deflate/gzip chunk cannot expand past ~264 KiB
 * before backpressure and the decoded-byte limit stop it.
 */
const DECODE_INPUT_SLICE_BYTES = 256;

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

interface RawInput {
  readonly stream: ReadableStream<Uint8Array>;
  readonly cancel: (reason?: string) => void;
}

/** Feed compressed bytes in small slices so backpressure and byte limits bound each decode step. */
function slicedInput(source: ReadableStream<Uint8Array>): RawInput {
  const reader = source.getReader();
  let rest: Uint8Array | undefined;
  let released = false;
  const cancel = (reason = GATE_STREAM_REASON): void => {
    if (released) {
      return;
    }
    released = true;
    rest = undefined;
    releaseStream(reader, reason);
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        while (rest === undefined || rest.byteLength === 0) {
          if (released) {
            controller.close();
            return;
          }
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
        cancel(typeof reason === 'string' ? reason : GATE_STREAM_REASON);
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, cancel };
}

async function readChunkWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    throw new RangeError(BUDGET_EXHAUSTED_DETAIL);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new RangeError('gate document decode timed out'));
    }, remaining);
  });
  try {
    const result = await Promise.race([reader.read(), timeout]);
    if (!result.done && performance.now() > deadline) {
      throw new RangeError(BUDGET_EXHAUSTED_DETAIL);
    }
    return result;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function logDecodeAbort(gate: RouteGate, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  if (detail === 'decoded stream exceeded byte limit') {
    logWarn(OVERSIZED_LOG, { gate: gate.name, route: gate.route });
    return;
  }
  logWarn(INCOMPLETE_LOG, { gate: gate.name, route: gate.route, detail });
}

async function openBoundedDecodedStream(
  decoded: ReadableStream<Uint8Array>,
  cancelUpstream: (reason?: string) => void,
  gate: RouteGate,
  left: number,
): Promise<ReadableStream<Uint8Array> | Uint8Array | undefined> {
  const deadline = performance.now() + left;
  const reader = decoded.getReader();
  const stopAll = (reason = GATE_STREAM_REASON): void => {
    cancelUpstream(reason);
    releaseStream(reader, reason);
  };
  let first: ReadableStreamReadResult<Uint8Array>;
  try {
    first = await readChunkWithin(reader, deadline);
  } catch (error) {
    stopAll();
    logDecodeAbort(gate, error);
    return undefined;
  }
  if (first.done) {
    reader.releaseLock();
    return new Uint8Array(0);
  }
  if (first.value.byteLength > MAX_GATE_SHELL_BYTES) {
    stopAll();
    logWarn(OVERSIZED_LOG, {
      gate: gate.name,
      route: gate.route,
    });
    return undefined;
  }
  let totalBytes = first.value.byteLength;
  let head: Uint8Array | undefined = first.value;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (head !== undefined) {
          const initial = head;
          head = undefined;
          controller.enqueue(initial);
          return;
        }
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await readChunkWithin(reader, deadline);
        } catch (error) {
          stopAll();
          logDecodeAbort(gate, error);
          controller.error(error);
          return;
        }
        if (next.done) {
          reader.releaseLock();
          controller.close();
          return;
        }
        totalBytes += next.value.byteLength;
        if (totalBytes > MAX_GATE_SHELL_BYTES) {
          stopAll();
          logWarn(OVERSIZED_LOG, {
            gate: gate.name,
            route: gate.route,
          });
          controller.error(new RangeError('decoded gate document exceeded MAX_GATE_SHELL_BYTES'));
          return;
        }
        controller.enqueue(next.value);
      },
      cancel(reason: unknown) {
        head = undefined;
        stopAll(typeof reason === 'string' ? reason : GATE_STREAM_REASON);
      },
    },
    { highWaterMark: 0 },
  );
}

export interface DecodeNonceDocumentInput {
  readonly response: Response;
  readonly gate: RouteGate;
  readonly gates: EdgeGates | undefined;
  readonly left: number;
}

/**
 * Stream a single-layer encoded gate HTML document within `MAX_GATE_SHELL_BYTES` and `left` ms so
 * `HTMLRewriter` can rewrite its per-response CSP nonces without retaining the full decoded body in
 * isolate memory. Multi-layer codings, unsupported codings, expired budgets, and initial decode
 * failures are cancelled and refused before headers leave; mid-stream oversize or stalled bodies
 * cancel the upstream reader and abort the response stream.
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
  if (left <= 0) {
    releaseStream(response.body, GATE_STREAM_REASON);
    logWarn(INCOMPLETE_LOG, {
      gate: gate.name,
      route: gate.route,
      detail: BUDGET_EXHAUSTED_DETAIL,
    });
    return undefined;
  }
  const alreadyDecoded = coding === undefined || gateBodyDecodedByFetch(gates, encoding);
  if (alreadyDecoded && Number(response.headers.get(CONTENT_LENGTH)) > MAX_GATE_SHELL_BYTES) {
    releaseStream(response.body, GATE_STREAM_REASON);
    logWarn(OVERSIZED_LOG, {
      gate: gate.name,
      route: gate.route,
    });
    return undefined;
  }
  // Fetch response bodies carry bytes; the Workers declaration leaves their element type open.
  const raw = response.body as ReadableStream<Uint8Array>;
  let decoded: ReadableStream<Uint8Array>;
  let cancelUpstream: (reason?: string) => void;
  if (coding === undefined || alreadyDecoded) {
    decoded = raw;
    cancelUpstream = () => {
      // `openBoundedDecodedStream` cancels `reader` directly when `decoded === raw`.
    };
  } else {
    const input = slicedInput(raw);
    decoded = decompressLive(input.stream, coding, MAX_GATE_SHELL_BYTES);
    cancelUpstream = input.cancel;
  }
  const stream = await openBoundedDecodedStream(decoded, cancelUpstream, gate, left);
  if (stream === undefined) {
    return undefined;
  }
  const headers = new Headers(response.headers);
  headers.delete(CONTENT_ENCODING);
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
    encodeBody: 'automatic',
  });
}
