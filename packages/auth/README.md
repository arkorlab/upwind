# @stayingupwind/auth

[Better Auth](https://better-auth.com), with nothing to configure.

```ts
// auth.ts, beside your app
import { defineAuth } from '@stayingupwind/auth';

export const auth = defineAuth({
  socialProviders: { github: {} },
});
```

```bash
upwind dev
```

That is a working sign-in. No client id, no client secret, no `AUTH_SECRET`, no database, and no
route to mount — press your sign-in button and you are signed in.

## What it fills in

Four decisions, each made only if you have not made it yourself.

|                         | Default                                                     | Yours instead                        |
| ----------------------- | ----------------------------------------------------------- | ------------------------------------ |
| **Where it is served**  | `/__upwind/auth`, and the route is written for you          | set `basePath` and mount it yourself |
| **What it signs with**  | a key kept in `.upwind/`, regenerated only if you delete it | `AUTH_SECRET`, or `secret`           |
| **What it stores in**   | the one D1 database your deployment published               | set `database`                       |
| **Who signs people in** | upwind, until real credentials exist                        | `clientId` / `clientSecret`          |

Everything else is Better Auth exactly as its documentation describes it. Options go through
untouched, plugins keep their types, and `auth.api` is inferred from what _you_ declared.

## The provider upwind plays

With no OAuth credentials and no `AUTH_SECRET` anywhere, `signIn.social({ provider: 'github' })`
does not reach GitHub. It reaches a page upwind serves:

> **upwind is standing in for GitHub**
> This is not GitHub. Nothing here reaches it, and no account of yours is involved.
>
> Sign in as `[ dev@localhost ]`

Type any address, press Continue, and you have a session as that user. Type another and you have a
second account to test with.

**It keeps the name you declared.** The stand-in _is_ the provider called `github`, so your
application calls `signIn.social({ provider: 'github' })` here and in production, and not a line of
it changes when the credentials arrive.

**Nothing leaves the machine.** The authorization step is a local page; the token exchange and the
userinfo call are function calls, not requests. There is no provider to register with, no callback
URL to whitelist, and no network to be on.

**It cannot appear in production.** It is not added to a production build at all, and refuses again
if it somehow is. A production run with no `AUTH_SECRET` does not fall back to anything — it answers
`500` and names the variable to set.

It goes away on its own, and it is deliberately easy to make it go away. Any one of these is enough:

- `secret` or `secrets` in the config, or `AUTH_SECRET` / `BETTER_AUTH_SECRET` in the environment;
- a `clientId`, `clientSecret` or `clientKey` on any provider you declared, or a provider declared
  as a function;
- **any** environment variable whose name ends in `CLIENT_ID` or `CLIENT_SECRET`.

The last one is broader than it needs to be, on purpose: standing in for a provider in a project
that has real credentials to hand would be the worse mistake. If you are surprised to find the
stand-in missing, an unrelated `…_CLIENT_ID` in your shell is the thing to look for.

Declared no providers at all? Then it answers to `upwind`:

```ts
import { authClient, DEV_PROVIDER_ID } from '@stayingupwind/auth/client';

await authClient.signIn.social({ provider: DEV_PROVIDER_ID });
```

## The route

`upwind dev` and `upwind build` write one file into your app:

```
app/%5F%5Fupwind/auth/[...all]/route.ts
```

It is four lines, and it is yours: commit it, edit it, or delete `auth.ts` and it goes too. Once you
have changed it, upwind never touches it again. (The `%5F` is Next.js's own escape — a folder whose
name starts with `_` is private and would not be routable.)

If you set a `basePath` of your own, that route answers `404` and mounting becomes yours:

```ts
// app/api/auth/[...all]/route.ts
import { toNextJsHandler } from 'better-auth/next-js';

import { auth } from '../../../../auth';

export const { GET, POST } = toNextJsHandler(auth);
```

**If your app has a Next.js `basePath`**, say `/docs`, then everything it serves is under it and
`/__upwind/auth` is not where this ends up. Set Better Auth's base path to the whole of it and mount
it yourself:

```ts
export const auth = defineAuth({ basePath: '/docs/__upwind/auth' });
```

## The client

```ts
import { createAuthClient } from '@stayingupwind/auth/client';

export const authClient = createAuthClient();
```

The only thing this adds to `better-auth/react` is the base path — the server is not at `/api/auth`,
and a client left on that default asks a path nothing serves. If you would rather import Better
Auth's client directly, take the constant instead:

```ts
import { createAuthClient } from 'better-auth/react';
import { UPWIND_AUTH_BASE_PATH } from '@stayingupwind/auth/client';

export const authClient = createAuthClient({ basePath: UPWIND_AUTH_BASE_PATH });
```

## The database, and its tables

The default is `@stayingupwind/sdk`'s rule: whichever D1 database your deployment published, as long
as it published exactly one. `upwind dev` and `upwind build` give a project one without being asked,
so there is nothing to create locally.

**Its tables are created for you in development, and only there, and only in that database.** A
database you configured yourself is yours to migrate — upwind has no standing to run DDL against
something a team may share — and a deployed Function never migrates anything: that belongs to
whatever deploys it. Use Better Auth's own CLI for both.

## What it costs

The auth route is an ordinary Next.js route handler, so it is evaluated by the first request that
reaches `/__upwind/auth` and by no other. A request that never touches authentication never
evaluates Better Auth.

The Function's script does grow: Better Auth and its dependencies added about **1.7 MB** to the app
Function in a minimal project. That is download and parse, not evaluation — the same trade upwind
already makes for `next/og`.

## Requirements

Next.js 16.2 or later, App Router, and `better-auth` 1.7 or later installed in your project — it is
a peer dependency, so you keep one copy and upwind uses yours.

## Licence

MIT or Apache-2.0, at your option.
