import {
  type DecodedGenerationPack,
  evaluateFreshness,
  type Validity,
} from '@stayingupwind/core/cache';

import type { GenerationLoad } from './generation-loader.ts';

/**
 * What to do with an entry's record, judged the way the authority and the runtime judge it
 * (`evaluateFreshness`), so no two of them serve different things.
 *
 * Served fresh or stale; a stale one regenerated behind the response. Expired, it is not served:
 * the deployment's Worker regenerates in the foreground and its render is the response. Without
 * a record, or with one that cannot be read, the build's own shell answers as it always has: the
 * build's generation is what the record would have said before anything regenerated, and a
 * record that is missing is most often one KV has not shown this region yet. A record this isolate
 * holds answers whatever KV says, past its hold as within it (`generation-hold.ts`); to a read KV
 * is out of reach for, this data center's copy answers when it has one (`generation-loader.ts`),
 * and otherwise a record this isolate came to hold meanwhile, unless that one has expired. A record
 * a Function's response condemned in this isolate — one that carries a tag the response said was
 * invalidated at once, written before the revision it said — is judged expired, whatever it says of
 * itself (`condemned.ts`).
 */

const OK_STATUS = 200;

export type ServedValidity = Exclude<Validity, 'expired'>;

export type GenerationDecision =
  | {
      readonly kind: 'serve';
      readonly pack: DecodedGenerationPack;
      readonly validity: ServedValidity;
      readonly source: string;
      /** The record's size, when this request read it from KV: told to the host once served. */
      readonly readBytes: number | undefined;
      readonly lookupMs: number;
    }
  | { readonly kind: 'regenerate'; readonly pack: DecodedGenerationPack; readonly lookupMs: number }
  | { readonly kind: 'build'; readonly reason: string; readonly lookupMs: number }
  | { readonly kind: 'passthrough'; readonly reason: string; readonly lookupMs: number };

function validityOf(pack: DecodedGenerationPack, now: number): Validity {
  const { header } = pack;
  return evaluateFreshness({
    policy: header.policy,
    cacheTimestamp: header.cacheTimestamp,
    invalidation: header.invalidation,
    now,
  }).validity;
}

interface RecordRead {
  readonly pack: DecodedGenerationPack;
  readonly source: string;
  readonly readBytes: number | undefined;
  readonly lookupMs: number;
}

/**
 * Whether serving `pack` at `now` asks for its regeneration, whatever this isolate was told of it: a
 * 200 past its `revalidate`, regenerated behind the response, or past its `expire`, regenerated in
 * the foreground (`decideRecord`). A record of another status is handed on before its freshness is
 * looked at, and one whose freshness cannot be told (`unknown`) asks for nothing.
 */
export function regeneratedWhenServed(pack: DecodedGenerationPack, now: number): boolean {
  if (pack.header.status !== OK_STATUS) {
    return false;
  }
  const validity = validityOf(pack, now);
  return validity === 'stale' || validity === 'expired';
}

/**
 * What this isolate was told of a record (`condemnedIn`): condemned, invalidated with a window it
 * leaves to the Function, or nothing.
 */
export type Condemned = (pack: DecodedGenerationPack) => 'expired' | 'stale' | undefined;

/** Why a record invalidated with a window goes to the Function (`condemnationOf`). */
const INVALIDATED_REASON = 'invalidated';

function decideRecord(read: RecordRead, now: number, condemned: Condemned): GenerationDecision {
  const { pack, source, readBytes, lookupMs } = read;
  if (pack.header.status !== OK_STATUS) {
    return { kind: 'passthrough', reason: `generation-status-${pack.header.status}`, lookupMs };
  }
  const validity = validityOf(pack, now);
  const condemnation = condemned(pack);
  if (validity === 'expired' || condemnation === 'expired') {
    return { kind: 'regenerate', pack, lookupMs };
  }
  if (condemnation === 'stale') {
    return { kind: 'passthrough', reason: INVALIDATED_REASON, lookupMs };
  }
  return { kind: 'serve', pack, validity, source, readBytes, lookupMs };
}

export function decideGeneration(
  load: GenerationLoad,
  now: number,
  condemned: Condemned,
): GenerationDecision {
  switch (load.kind) {
    case 'generation': {
      const { pack, source, readBytes, lookupMs } = load;
      return decideRecord({ pack, source, readBytes, lookupMs }, now, condemned);
    }
    case 'none': {
      return { kind: 'build', reason: 'no-record', lookupMs: load.lookupMs };
    }
    case 'unusable': {
      return { kind: 'build', reason: load.reason, lookupMs: load.lookupMs };
    }
    case 'unavailable': {
      if (load.held === undefined) {
        return { kind: 'build', reason: 'record-unavailable', lookupMs: load.lookupMs };
      }
      const decision = decideRecord(
        { pack: load.held, source: 'memory', readBytes: undefined, lookupMs: load.lookupMs },
        now,
        condemned,
      );
      // The held record still proves that this entry has expired. Reverting to the build would
      // resurrect older content and bypass its hard expiry; ask the runtime to regenerate just
      // as when KV returned this same record. What that costs while KV is out — a render at the
      // application's Worker for every such request, since a foreground regeneration is the
      // response and no cooldown bounds it — is the price of never serving past a hard expiry.
      return decision;
    }
  }
}
