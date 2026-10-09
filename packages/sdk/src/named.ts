import type {
  D1Database,
  DurableObjectNamespace,
  KVNamespace,
  R2Bucket,
  Rpc,
} from '@cloudflare/workers-types';

import { BLOB, D1, type Kind, KV, DURABLE_OBJECT } from './kinds.ts';
import { read, unreadable } from './published.ts';

/**
 * Storage by the name it was bound under.
 *
 * A name and nothing else. A name nothing is published under, or one that is published as another
 * kind of storage, answers `undefined` — never the one thing the project happens to have. A typo
 * that fell back to a default is a typo nobody ever finds; a KV namespace answering to `d1('DB')` is
 * one found at the first `prepare`, in a stack that says nothing about the name that was wrong.
 */
function byName(name: string, kind: Kind): unknown {
  const reading = read();
  if (reading.state === 'unreadable') {
    // The one thing here that throws. "This run published a shape I cannot read" is not an answer
    // about a name, and `undefined` would send the reader looking for a binding that may well exist.
    throw new Error(unreadable(reading.saw));
  }
  if (reading.state === 'absent') {
    return undefined;
  }
  // A name the map holds itself, and not one it inherits. What is published was checked entry by
  // entry (`published.ts`), and an entry reached through a prototype is not one of those — it is
  // whatever the object behind the symbol was made from, which this package did not make.
  const found = Object.hasOwn(reading.published.resources, name)
    ? reading.published.resources[name]
    : undefined;
  // The kind is checked here and nowhere else. What comes back is Cloudflare's own object, which is
  // `unknown` until this line and whichever of theirs the kind says it is after it.
  return found?.type === kind.type ? found.binding : undefined;
}

/** The D1 database bound under this name, or nothing — including when it is not a D1 database. */
export function d1(name: string): D1Database | undefined {
  return byName(name, D1) as D1Database | undefined;
}

/** The KV namespace bound under this name, or nothing — including when it is not a KV namespace. */
export function kv(name: string): KVNamespace | undefined {
  return byName(name, KV) as KVNamespace | undefined;
}

/** The R2 bucket bound under this name, or nothing — including when it is not an R2 bucket. */
export function blob(name: string): R2Bucket | undefined {
  return byName(name, BLOB) as R2Bucket | undefined;
}

/** The native Durable Object namespace bound under this name, or nothing. */
export function durableObject<T extends Rpc.DurableObjectBranded | undefined = undefined>(
  name: string,
): DurableObjectNamespace<T> | undefined {
  return byName(name, DURABLE_OBJECT) as DurableObjectNamespace<T> | undefined;
}
