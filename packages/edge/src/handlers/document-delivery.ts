import type { EncodedShellRef, ShellEncoding } from '@stayingupwind/core/artifact';
import type { RouteEntry } from '@stayingupwind/core/manifest';
import {
  brotliWire,
  gzipWire,
  identityWire,
  joinedWire,
  type WireEncoding,
} from '@stayingupwind/host/splice';

import { logWarn } from '../observability/logger.ts';
import type { ShellLoadResult } from '../strategies/shell-loader.ts';
import { IDENTITY_ENCODING, type ShellDelivery } from './document-headers.ts';

/**
 * Which wire a document the edge composes goes out on, once its shell and any rendering of it have
 * been read: a rendering's pre-compressed head, alone or under a second layer, or the identity
 * shell, compressed on the way out where the client takes a coding (`ShellDelivery`).
 */

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

export interface DeliveryInput {
  readonly entry: RouteEntry;
  readonly shell: Extract<ShellLoadResult, { kind: 'ok' }>;
  readonly lookupMs: number;
  readonly encoding: ShellEncoding | typeof IDENTITY_ENCODING;
  readonly rendering: EncodedShellRef | undefined;
  readonly read: ShellLoadResult | undefined;
  readonly layering: Layering;
}

/** How the document goes out, once the shell and whatever rendering there was have been read. */
export function deliveryFor(input: DeliveryInput): ShellDelivery {
  const { shell, encoding } = input;
  const head = renderingWire(input.entry, input.rendering, input.read);
  const common = { source: shell.read.source, lookupMs: input.lookupMs, encoding };
  if (head === undefined) {
    const outbound = encoding === IDENTITY_ENCODING ? 'none' : 'live';
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
