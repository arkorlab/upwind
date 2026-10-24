import { connection } from 'next/server';

import { bucket, database, kv, published } from '../../../lib/resources';

/**
 * The deployment's storage, used for real: a key written and read back, an object stored and read
 * back, and a query answered — each through the binding the host published, and nothing else.
 */
export async function GET(): Promise<Response> {
  // Nothing is published while the app is built: what this answers is the request's.
  await connection();
  const found = published();
  if (found === undefined) {
    return Response.json({ published: false }, { status: 503 });
  }
  const cache = kv('CACHE');
  const uploads = bucket('UPLOADS');
  const db = database('DB');
  await cache?.put('greeting', 'from kv');
  await uploads?.put('greeting.txt', 'from r2');
  const stored = await uploads?.get('greeting.txt');
  return Response.json({
    version: found.version,
    resources: Object.entries(found.resources).map(([name, entry]) => [name, entry.type]),
    frozen: Object.isFrozen(found) && Object.isFrozen(found.resources),
    kv: (await cache?.get('greeting')) ?? null,
    r2: (await stored?.text()) ?? null,
    d1: (await db?.prepare('SELECT 1 + 1 AS two').first<{ two: number }>())?.two ?? null,
  });
}
