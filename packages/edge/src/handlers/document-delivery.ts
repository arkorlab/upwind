import type { EncodedShellRef, ShellEncoding } from '@stayingupwind/core/artifact';
import type { GenerationPackHeader } from '@stayingupwind/core/cache';
import type { RouteEntry } from '@stayingupwind/core/manifest';
import {
  brotliWire,
  buildRecoveryBytes,
  gzipWire,
  identityWire,
  joinedWire,
  type WireEncoding,
} from '@stayingupwind/host/splice';

import type { ServedValidity } from '../cache/decision.ts';
import type { DetachedRegeneration } from '../cache/regenerate.ts';
import { logWarn } from '../observability/logger.ts';
import type { ShellLoadResult } from '../strategies/shell-loader.ts';
import { noncedBody } from './csp-nonce.ts';
import { IDENTITY_ENCODING, type ShellDelivery } from './document-headers.ts';

/**
 * Which wire a document the edge composes goes out on, once its shell and any rendering of it have
 * been read: a rendering's pre-compressed head, alone or under a second layer, or the identity
 * shell, compressed on the way out where the client takes a coding (`ShellDelivery`) — and the body
 * that goes out on it, a nonce stamped on its shell where it carries one (`documentBody`).
 */

const RECOVERY_HTML = buildRecoveryBytes();

/**
 * The pre-compressed head to put on the wire, or `undefined` when there is none to use. A
 * rendering that cannot be read is not a reason to proxy the document, nor to send it larger: the
 * identity shell is at hand and is compressed on the way out instead.
 */
function renderingWire(
  entry: RouteEntry,
  rendering: EncodedShellRef | undefined,
  read: ShellLoadResult | undefined,
): WireEncoding | undefined {
  if (rendering === undefined || read === undefined) {
    return undefined;
  }
  if (read.kind !== 'ok') {
    logWarn('shell rendering unavailable, compressing on the way out', {
      encoding: rendering.encoding,
      sha256: rendering.sha256,
      kind: read.kind,
    });
    return undefined;
  }
  if (rendering.encoding === 'br') {
    return brotliWire(read.read.bytes);
  }
  return gzipWire(read.read.bytes, {
    crc32: rendering.crc32,
    byteLength: entry.shell.byteLength,
  });
}

/**
 * Whether a brotli rendering goes under the second layer. `off`: nothing for the client to decide —
 * the document is complete, so there is no suffix to compress, or another coding was negotiated, or
 * the deployment turned the layer off. `declined`: the client's user agent is not one known to undo
 * two codings (`layered-clients.ts`). `on`: it is.
 */
export type Layering = 'off' | 'declined' | 'on';

/**
 * What a document's delivery reads of the generation it serves: its two bodies, and this much of
 * what its header says — all a record read whole has (`DecodedGenerationPack`), and what a gate's
 * shell is given to be served as one (`gateGeneration`).
 */
export interface ServedPack {
  readonly header: Partial<Pick<GenerationPackHeader, 'tags'>> &
    Pick<
      GenerationPackHeader,
      'headers' | 'htmlLength' | 'htmlSha256' | 'pathname' | 'route' | 'seq' | 'source'
    >;
  readonly html: Uint8Array;
  /** `undefined` for a generation complete in itself, which nothing resumes. */
  readonly postponed: Uint8Array | undefined;
}

/**
 * The gate whose shell a document is served from, in place of the route's own (`gateGeneration`):
 * its name, and what it said to tell the resume beside the request (`GATE_RESUME_HEADER`).
 */
export interface ServedGate {
  readonly name: string;
  readonly told: Readonly<Record<string, string>> | undefined;
}

/**
 * The generation a hosted application's document is served from, when the deployment's runtime
 * cache holds one: its record is the shell, its state is what the resume completes, and what it
 * says of its own freshness is on the wire for whoever reads the markers. A gate's shell is served
 * as one, and says whose it is (`gate`).
 */
export interface ServedGeneration {
  readonly pack: ServedPack;
  readonly validity: ServedValidity;
  /** Where the record came from: this isolate's memory, this data center's copy, or KV. */
  readonly source: string;
  /**
   * The record's size as this request read it from KV; none for a record the isolate held, or one
   * the data center's copy answered with.
   */
  readonly readBytes: number | undefined;
  readonly lookupMs: number;
  /** The record is a member's own, read beside the class shell's (`concreteUpgrade`). */
  readonly member: boolean;
  /** What the resume is told beside the request when the entry is to be regenerated behind it. */
  readonly regeneration: Readonly<Record<string, string>> | undefined;
  /** Give its ask back when the visitor takes the resume away before it answers. */
  readonly onAbandoned?: (() => void) | undefined;
  /**
   * The regeneration asked beside the resume has begun: its answer said the runtime accepted it
   * (`regenerationAccepted`), and the resume has ended, which is where the runtime begins it. Not
   * for an ask it skipped, nor for one whose resume was let go before it answered.
   */
  readonly onRegenerating?: (() => void) | undefined;
  /**
   * The regeneration asked beside the resume will not begin: the resume answered without the
   * runtime accepting it, or never answered. Called once, and never beside `onRegenerating`.
   */
  readonly onDeclined?: (() => void) | undefined;
  /**
   * The regeneration asked behind a document complete in itself as a request of its own, there being
   * no resume to ask beside (`triggerDetached`): the document's point counts its dispatches.
   */
  readonly detached?: DetachedRegeneration | undefined;
  /**
   * What serving the record sets off behind the response (`readServedAgain`), called once the
   * document is certain to go out from it, whole or resumed: not for one handed to the application
   * whole instead (`delegateSandboxedDocument`), which serves nothing of the record and dispatches no
   * resume for its regeneration to ride.
   */
  readonly onServed: (() => void) | undefined;
  /** The gate whose shell this is, where a gate answered with one; none for a record. */
  readonly gate?: ServedGate | undefined;
}

export interface DeliveryInput {
  readonly entry: RouteEntry;
  readonly shell: Extract<ShellLoadResult, { kind: 'ok' }>;
  readonly lookupMs: number;
  readonly encoding: ShellEncoding | typeof IDENTITY_ENCODING;
  readonly rendering: EncodedShellRef | undefined;
  readonly read: ShellLoadResult | undefined;
  readonly layering: Layering;
  /** A `HEAD`: answered with no body, for which no rendering is read. */
  readonly bodiless: boolean;
}

/** How the document goes out, once the shell and whatever rendering there was have been read. */
export function deliveryFor(input: DeliveryInput): ShellDelivery {
  const { shell, encoding } = input;
  const head = renderingWire(input.entry, input.rendering, input.read);
  const common = { source: shell.read.source, lookupMs: input.lookupMs, encoding };
  if (head === undefined) {
    // A `HEAD` reads no rendering and sends no bytes, and says of itself what its `GET` sends: the
    // rendering the manifest names, where there is one, not the live encoding that stands in for
    // one only when it cannot be read. Its wire is never sent.
    const stored = input.bodiless && input.rendering !== undefined;
    const outbound = encoding === IDENTITY_ENCODING || stored ? 'none' : 'live';
    return { ...common, wire: identityWire(shell.read.bytes), outbound, variesByAgent: false };
  }
  if (input.layering === 'off' || head.encoding !== 'br') {
    return { ...common, wire: head, outbound: 'none', variesByAgent: false };
  }
  // The second layer flushes once per array the splice hands it: each chunk's frames in one.
  return input.layering === 'on'
    ? { ...common, wire: joinedWire(head), outbound: 'layered', variesByAgent: true }
    : { ...common, wire: head, outbound: 'none', variesByAgent: true };
}

/**
 * What the splice puts on the wire for the shell, and what it appends where the resume fails: the
 * delivery's wire and the recovery script as they are, or — for a document with a nonce, whose shell
 * goes ahead of the splice, stamped (`noncedBody`) — no shell at all, and the script with the nonce
 * written into it, as nothing stamps it after.
 */
export function spliceShell(
  shell: Uint8Array,
  delivery: ShellDelivery,
  nonce: string | undefined,
): { readonly shell: Uint8Array; readonly wire?: WireEncoding; readonly recoveryHtml: Uint8Array } {
  if (nonce === undefined) {
    return { shell, wire: delivery.wire, recoveryHtml: RECOVERY_HTML };
  }
  return { shell: new Uint8Array(), recoveryHtml: buildRecoveryBytes({ nonce }) };
}

/**
 * The body of a document the edge composes: the shell as the wire carries it, then what the splice
 * puts behind it where a resume completes the document (`rest`) — or, for one with a nonce, the
 * shell stamped with it and the rest after it as it came (`noncedBody`).
 */
export function documentBody(
  entry: RouteEntry,
  shell: { readonly bytes: Uint8Array; readonly wire: WireEncoding },
  nonce: string | undefined,
  rest?: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  if (nonce !== undefined) {
    return noncedBody(shell.bytes, entry.shell.contentType, nonce, rest);
  }
  return rest ?? wireBody(shell.wire);
}

/** A document complete as it is: the wire's shell as the body, ended, nothing spliced behind it. */
function wireBody(wire: WireEncoding): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(wire.shell);
      const end = wire.finish();
      if (end.byteLength > 0) {
        controller.enqueue(end);
      }
      controller.close();
    },
  });
}
