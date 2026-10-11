# @stayingupwind/sdk

An application's own storage, with nothing to configure.

```ts
import db from '@stayingupwind/sdk/db';

export default async function Page() {
  const { n } = (await db.prepare('select 1 as n').first<{ n: number }>()) ?? { n: 0 };
  return <p>{n}</p>;
}
```

There is no configuration file, no client to construct and no credentials anywhere. `upwind dev` and
`upwind build` bind a project's local storage before they run any of it; a deployment's Function
publishes the storage its deployment attached. Both publish it the same way, so this package reads
it the same way in both places.

## What there is

| Import                                       | What it is                                                |
| -------------------------------------------- | --------------------------------------------------------- |
| `import db from '@stayingupwind/sdk/db'`     | the project's D1 database, if exactly one is published    |
| `import kv from '@stayingupwind/sdk/kv'`     | the project's KV namespace, likewise                      |
| `import blob from '@stayingupwind/sdk/blob'` | the project's R2 bucket, likewise                         |
| `d1(name)`, `kv(name)`, `blob(name)`         | storage by the name it was bound under                    |
| `published()`                                | everything published, and the names it is published under |

The default exports are lazy: nothing is resolved until the first time one is used, because a
module is evaluated before there is any storage to be. Everything else is a plain function.

## The rule for a bare `db`

**Exactly one of a kind, whatever it is called.** With one D1 database published, `db` is it. With
none, or with more than one, `db` throws and says which of the two happened — with more than one it
lists them, so the fix is to name the one you meant:

```ts
import { d1 } from '@stayingupwind/sdk/db';

const orders = d1('ORDERS');
```

No name is matched and no name is special. That is what lets the same rule serve a project that was
handed a database without asking for one and a project that declared a single database of its own,
under a name of its choosing — and it is why `d1('ORDERS')` never quietly falls back to some other
database when `ORDERS` is not there. A name that is not published, or is published as another kind
of storage, is `undefined`.

## What it reads

`globalThis[Symbol.for('upwind.resources')]`, which holds a version and the bindings by name —
never an environment variable, and never a binding of the platform's, whatever an application
happens to name. Nothing here writes it.

Reading it has three answers, and this package keeps them apart:

- **published** — what you asked for, or `undefined` from `d1`/`kv`/`blob` for a name that is not there.
- **nothing published** — no storage in this run at all. A plain `next dev` or `next build` is the
  usual reason; those publish nothing, and the error says so.
- **a version this package does not read** — `upwind` and `@stayingupwind/sdk` from different
  releases. A different accident with a different fix, so it is never reported as "nothing published".

## Types

The SDK includes the required storage types: `D1Database`, `KVNamespace` and `R2Bucket` from
[`@cloudflare/workers-types`](https://www.npmjs.com/package/@cloudflare/workers-types), imported
rather than assumed as globals — no `tsconfig` of yours needs to know about any of this.

Which means a query builder needs nothing from here either:

```ts
import db from '@stayingupwind/sdk/db';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from './schema.ts';

export const orm = drizzle(db, { schema });
```

## Licence

MIT or Apache-2.0, at your option.

## Durable Objects

A host can register a binding name, a project-relative module path and its named class export.
The adapter builds that class into a small Worker of its own; Next.js Functions receive a native
`DurableObjectNamespace`. Defining the class never instantiates an object. The host controls namespace
identity, code updates and removal, so consult its documentation for deployment and rollback behavior.

```ts
// src/objects/counter.ts
import { DurableObject } from 'cloudflare:workers';

export class Counter extends DurableObject {
  async increment(): Promise<number> {
    const value = ((await this.ctx.storage.get<number>('count')) ?? 0) + 1;
    await this.ctx.storage.put('count', value);
    return value;
  }
}
```

```ts
// app/api/counter/route.ts
import { durableObject } from '@stayingupwind/sdk';

import type { Counter } from '../../../src/objects/counter';

export async function POST() {
  const counters = durableObject<Counter>('COUNTERS');
  if (counters === undefined) return new Response('Binding unavailable', { status: 503 });
  return Response.json({ count: await counters.getByName('visits').increment() });
}
```

`durableObject(name)` returns `undefined` for a missing name or a binding of another kind. The default
export from `@stayingupwind/sdk/durable-object` follows the same one-of-a-kind rule as `db`. Namespaces
and stubs retain Cloudflare's native methods, including RPC and `fetch`; the SDK adds no network call.
Class modules use their constructor's native `env` for other bindings. Use type-only imports of these
classes from Next.js code so their Worker-only modules stay outside the application's bundle.

For a Server Component on a host that builds without storage, call `await connection()` from
`next/server` before the first operation and put that component under `<Suspense>`. This keeps the
operation at request time while its surrounding shell can be prerendered. Route Handlers serving
`POST` and Server Actions already run at request time.

For local runs, pass the host's exported registrations through `UPWIND_DURABLE_OBJECTS`:

```bash
UPWIND_DURABLE_OBJECTS='[{"name":"COUNTERS","module":"src/objects/counter.ts","className":"Counter"}]' pnpm upwind dev
```

The same input works for `upwind build`. Local objects use SQLite storage in `.upwind/`, keep their
state when the server restarts, and execute source edits after the dev supervisor restarts. Startup
obtains namespace handles without creating or calling objects. Plain `next dev` publishes no bindings.
For hosted placement, choose a `locationHint` on `get()` or `getByName()` only when the app needs one;
otherwise the first actual access places the object near its caller. See Cloudflare's
[namespace API](https://developers.cloudflare.com/durable-objects/api/namespace/) and
[data location](https://developers.cloudflare.com/durable-objects/reference/data-location/).
