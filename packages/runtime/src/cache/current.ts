import {
  type DecodedGenerationPack,
  decodeGenerationPack,
  deriveEntry,
  evaluateFreshness,
  type RouteEntryDescriptor,
  type Validity,
  verifyGenerationPack,
} from '@upwind/core/cache';
import { withDeadline } from '@upwind/core/util';

import type { CacheRuntime } from './runtime.ts';

/**
 * The current generation of an entry, as the Worker reads it when it answers a document itself:
 * the same delivery record the edge reads, through the host, kept for one hold. What the
 * record says is judged the way the edge judges it, so the two never serve different things.
 */

interface CurrentGeneration {
  readonly entryId: string;
  readonly pack: DecodedGenerationPack;
  readonly validity: Validity;
}

export type CurrentLookup =
  | { readonly kind: 'generation'; readonly current: CurrentGeneration }
  | { readonly kind: 'none'; readonly entryId: string }
  | { readonly kind: 'unavailable'; readonly entryId: string };

/**
 * How long a document waits for its record before the build's own shell answers instead. The
 * Worker answers a document itself only where the edge could not serve the shell; the record is
 * a bonus there, not a wait the visitor should notice.
 */
const RECORD_DEADLINE_MS = 200;

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readPack(
  runtime: CacheRuntime,
  entryId: string,
): Promise<DecodedGenerationPack | null> {
  const remembered = runtime.recordMemo.get(entryId);
  if (remembered !== undefined) {
    return remembered;
  }
  const bytes = await withDeadline(
    runtime.host.readRecord(entryId),
    RECORD_DEADLINE_MS,
    'delivery record',
  );
  let pack: DecodedGenerationPack | null = null;
  if (bytes !== undefined) {
    const decoded = decodeGenerationPack(bytes);
    if (decoded.kind === 'ok' && (await verifyGenerationPack(decoded.pack))) {
      pack = decoded.pack;
    }
  }
  runtime.recordMemo.set(entryId, pack);
  return pack;
}

/** How far each state keeps a generation from being answered; `unknown` is served as `fresh` is. */
const SEVERITY: Readonly<Record<Validity, number>> = { fresh: 0, unknown: 0, stale: 1, expired: 2 };

function worse(a: Validity, b: Validity): Validity {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}

/** The entry's current generation and how it stands at `now`; unavailable when the host is. */
export async function currentGeneration(
  runtime: CacheRuntime,
  descriptor: RouteEntryDescriptor,
  now: number,
): Promise<CurrentLookup> {
  const { entryId } = await deriveEntry(runtime.scopeId, descriptor);
  let pack: DecodedGenerationPack | null;
  try {
    pack = await readPack(runtime, entryId);
  } catch (error) {
    runtime.log('delivery record not read', { entryId, detail: detail(error) });
    return { kind: 'unavailable', entryId };
  }
  if (pack === null) {
    return { kind: 'none', entryId };
  }
  const { header } = pack;
  const { validity: recorded } = evaluateFreshness({
    policy: header.policy,
    cacheTimestamp: header.cacheTimestamp,
    invalidation: header.invalidation,
    now,
  });
  // What this isolate knows of the generation's tags counts as well: its own invalidation is in
  // force here at once (`applyLocal`), and the record — read through the host, and kept for a
  // hold — may say nothing of it yet. Judged on the record alone, a page revalidated by this
  // Worker went on being answered as it was until the hold ran out.
  const tagged = runtime.tags.validityOf(
    header.tags.map((tag) => tag.value),
    header.cacheTimestamp ?? header.producedAt ?? 0,
    now,
  );
  return { kind: 'generation', current: { entryId, pack, validity: worse(recorded, tagged) } };
}
