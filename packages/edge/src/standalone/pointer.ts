import { type EdgePointer, edgePointerSchema } from '@stayingupwind/host/delivery';

import type { EdgeRuntime } from '../edge-runtime.ts';
import { logWarn } from '../observability/logger.ts';
import { createPointerReader } from '../preview/pointer.ts';
import { heldBehind, type Lookup, MISSING } from '../preview/storage.ts';
import type { StandaloneEnv } from './env.ts';

const UNAVAILABLE: Lookup<never> = { kind: 'unavailable' };

function parsed(raw: unknown): EdgePointer | undefined {
  const pointer = edgePointerSchema.safeParse(raw);
  return pointer.success ? pointer.data : undefined;
}

/** The edge's own pointer, as a standalone edge reads one moved in `EDGE_STATE` (`POINTER_KEY`). */
const KV_POINTERS = createPointerReader<EdgePointer, undefined>({ parse: parsed });

const pinned = new WeakMap<StandaloneEnv, Lookup<EdgePointer>>();

/**
 * The pointer this version of the edge was deployed with (`POINTER`), parsed once per `env`. One
 * that is not a pointer is no pointer to serve, and every request is answered `503` until the edge
 * is deployed with one: said once, where it is parsed, as one in `EDGE_STATE` that is not a pointer
 * is (`invalid active pointer`), so that whoever deployed it can tell why the site answers nothing.
 */
function pinnedPointer(env: StandaloneEnv, json: string): Lookup<EdgePointer> {
  const held = pinned.get(env);
  if (held !== undefined) {
    return held;
  }
  let raw: unknown;
  let notJson = false;
  try {
    raw = JSON.parse(json);
  } catch {
    notJson = true;
  }
  const pointer = parsed(raw);
  if (pointer === undefined) {
    logWarn('invalid pinned pointer', { detail: notJson ? 'not JSON' : 'not a pointer' });
  }
  const lookup: Lookup<EdgePointer> =
    pointer === undefined ? UNAVAILABLE : { kind: 'found', value: pointer };
  pinned.set(env, lookup);
  return lookup;
}

/**
 * What the edge serves: the pointer it was deployed with, or the one kept under `POINTER_KEY` —
 * read as any host's pointer is, from the isolate while it is fresh and behind the answer once it
 * is not (`PointerReader.get`). An edge given neither serves nothing.
 */
export async function standalonePointer(
  env: StandaloneEnv,
  runtime: EdgeRuntime,
  ctx: ExecutionContext,
): Promise<Lookup<EdgePointer>> {
  if (env.POINTER !== undefined) {
    return pinnedPointer(env, env.POINTER);
  }
  if (env.POINTER_KEY !== undefined) {
    return KV_POINTERS.get(env, runtime, env.POINTER_KEY, { holdRefresh: heldBehind(ctx) });
  }
  return MISSING;
}
