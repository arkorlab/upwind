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

The three default exports are lazy: nothing is resolved until the first time one is used, because a
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
import { drizzle } from 'drizzle-orm/d1';
import db from '@stayingupwind/sdk/db';

import * as schema from './schema.ts';

export const orm = drizzle(db, { schema });
```

## Licence

MIT or Apache-2.0, at your option.
