# upwind

## Workers AI

AI bindings are explicit capabilities. Declare their names as a JSON array:

```sh
export UPWIND_AI_BINDINGS='["INFERENCE"]'
upwind dev
```

This publishes an unavailable inference capability, so AI calls give a clear opt-in error while local
D1, KV, R2 and Durable Objects remain usable. There is no local AI emulator. Builds always keep AI
disabled, including when the development flag was used in another process.

To use real Workers AI during development, set your own `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN`, then run `upwind dev --remote-ai`. The token needs Workers AI access and the
Worker preview permissions required by Wrangler's remote-binding session. Upwind does not initiate
a login, invoke a model or load the model catalogue during setup. Actual inference uses your account
and incurs Cloudflare charges; ordinary CI should use doubles instead.

The remote session is disposed when development stops or restarts. A connection or authentication
failure leaves other local resources available. Customer Durable Objects receive the same restricted
service binding under the declared name in `this.env`, rather than the account-wide native `Ai`.

`@stayingupwind/sdk/ai` selects the sole binding lazily. `ai(name)` supports named access. See the
[SDK documentation](../sdk/README.md#workers-ai-inference) for an explicit POST Route Handler example.

### 日本語

`UPWIND_AI_BINDINGS='["INFERENCE"]'` で AI バインディング名を明示します。通常の開発とビルドでは
推論を実行できません。実際の Workers AI を使う場合だけ、自分の Cloudflare アカウントの
`CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_API_TOKEN` を設定し、`upwind dev --remote-ai` を実行します。
推論はそのアカウントへ課金されます。起動時にモデルの呼び出しや自動ログインは行いません。
接続や認証が失敗しても、ローカルの D1・KV・R2・Durable Objects は利用できます。

SDK は `run(model, inputs)` のみ提供し、第三引数、AI Gateway、外部プロバイダー、私有 LoRA、
Batch、WebSocket は提供しません。既定アクセサーは AI が一つの場合に選択し、複数の場合は
`ai(name)` を使います。有料推論をビルドやプリフェッチで実行しないよう、POST Route Handler から
明示的に呼び出してください。

`upwind dev` runs a Next.js development server behind upwind's own front door.

```bash
pnpm add -D upwind
pnpm upwind dev
```

`upwind` alone is enough to serve an application and to answer `/__upwind`. A project that also has
`@stayingupwind/adapter` installed — which is what builds the deployment — gets the second half of the
arrangement below as well, where the prefix is reserved inside Next.js's own routing.

```
  upwind 0.4.0 dev
  - Local:     http://localhost:3000
  - Internal:  http://localhost:3000/__upwind

  ✓ Next.js 16.4.2 ready in 1127ms
```

A deployment has an edge in front of it, and the platform's own paths are the edge's to serve. Under
`next dev` there is no edge. `upwind dev` is that front door locally: it holds the port, answers
`/__upwind` itself, and hands every other request to Next.js.

## What it wraps

upwind listens, and Next.js runs in the same process behind it, started the way Next.js documents a
custom server:

```
client → upwind's http.Server
          ├─ /__upwind, /__upwind/… → answered here; Next.js never sees it
          └─ everything else        → next({ dev: true }) → prepare() → getRequestHandler()
upgrade  → Next.js (HMR and the error overlay speak over a WebSocket of their own)
```

That API is a thin wrapper over the same `getRequestHandlers` the `next dev` worker runs, so the dev
bundler, HMR, the error overlay and the request log are the ones Next.js would have used — in this
process, on this port, with no second server and no proxy hop in between.

What Next.js's _parent_ process does, `upwind dev` does: the banner, and starting the server again
when it asks to be restarted. A restart has to be a new process, because what is thrown away is
everything the old one loaded, so `upwind dev` is two processes — a supervisor, and the child that
serves. Exit code 77 means "start me again"; that is Next.js's own `RESTART_EXIT_CODE`, and both a
change to `next.config` and the error overlay's restart button leave with it.

The third thing that parent does is write `AGENTS.md` (and, before Next.js 16.4, a `CLAUDE.md`
beside it). Run by an AI coding agent against a project whose agent-rules block is missing or out of
date, `next dev` writes the current one — the block that says this major is not the Next.js the
agent was trained on. `upwind dev` asks the project's own Next.js to do exactly that, so the files
say what that Next.js says, and `agentRules: false` in `next.config` turns it off here as it does
there.

The banner says one more thing when it has to: a project whose Next.js is older than the newest
release carrying security fixes is told so, right under the version line. `upwind` and
`@stayingupwind/adapter` name the same floor, and the adapter says it again once a build is written.
It is worth saying in both places, because the two are exposed to different things: a deployment's
Function carries the project's own Next.js, the React Server Components transport it vendors
included, and a development run also optimizes `/_next/image` itself, where a deployment answers
that path without Next.js in it. Nothing is refused — the run is yours, and a project held to an
older Next.js still has to be runnable.

Everything is resolved from the project, not from this package: the Next.js that runs an application
is the copy the application itself depends on, and so is the adapter below.

## `/__upwind`

Answered by the front door, which is why it answers while the application is still compiling and
while a compile of it is failing — what you ask when nothing works must not depend on the thing that
is not working.

| Path               | Answers                                                                      |
| ------------------ | ---------------------------------------------------------------------------- |
| `/__upwind`        | what this run is: versions, address, project directory, the adapter it named |
| `/__upwind/health` | `200` once Next.js is ready, `503` while it is starting                      |

```console
$ curl -s localhost:3000/__upwind
{
  "upwind": "0.4.0",
  "next": "16.4.2",
  "ready": true,
  "address": "http://localhost:3000",
  "prefix": "/__upwind",
  "projectDir": "/home/you/app",
  "adapter": "/home/you/app/node_modules/@stayingupwind/adapter/dist/index.js",
  "startedAt": "2026-09-26T08:22:21.884Z",
  "readyInMs": 1127,
  "endpoints": ["/__upwind", "/__upwind/health"]
}
```

The rules every endpoint here is held to:

- **`GET` and `HEAD` only.** Anything else is `405`. When something here has a reason to change
  state it will need more than a method, because a page on another origin can _send_ a request to
  this port.
- **No `access-control-allow-origin`, ever.** The same-origin policy is the whole of the protection
  a developer's machine has here: another origin may send a request, and must not be able to read
  what came back.
- **`cache-control: no-store`.** Every answer describes a moment.
- **An unknown path answers with the paths that are known**, so a typo in a tool's URL says so
  rather than looking like a server that is not running.
- **HTTP only.** Nothing here is served over a WebSocket: the one upgrade listener on this server is
  Next.js's, which is what HMR needs.

## The prefix is reserved twice

`/__upwind` never reaches the application's router, because the front door answers it first. That is
the whole of the arrangement in the ordinary case.

A request can still arrive at Next.js's router from inside — a middleware that rewrites to
`/__upwind/…`, a request Next.js makes of itself — and without a reservation a catch-all route the
project happens to have (`app/[...slug]/page.tsx`) would answer it. So `upwind dev` also points
Next.js at `@stayingupwind/adapter` (through `NEXT_ADAPTER_PATH`, and only if nothing already names
an adapter), and the adapter puts the prefix in `beforeFiles` — ahead of the filesystem — pointing at
this server's own address, which it reads from `UPWIND_DEV_ADDRESS`.

Nothing of that happens under a plain `next dev`: with no upwind in front there is no address to
send anything to, and the adapter leaves the project's routing exactly as the project wrote it. A
project's own `rewrites` are kept in the list they were declared in either way.

## `upwind build`

```bash
pnpm upwind build
```

The project's own `next build`, with the adapter named and with the project's storage bound. The
bundle under `.arkor/` is `@stayingupwind/adapter`'s work and the build is Next.js's; what was
missing was the thing `upwind dev` already does, which is to say _which_ adapter, resolved from the
project rather than from wherever this CLI is installed.

## Storage during a build

A page can read the project's own storage while it prerenders — `generateStaticParams` pulling its
slugs out of D1 is the case this is for — and `upwind build` is what makes that possible: it hands
the process that renders a runtime bound to `.upwind/`, the same one `upwind dev` uses, and tells the
adapter to render in one process because a directory of storage belongs to one runtime at a time.

Two consequences worth knowing before you meet them.

- **A plain `next build` publishes no storage.** It still produces the same bundle, with the adapter
  named in `next.config`; what it cannot do is prerender a page that reads storage, and
  `@stayingupwind/sdk` says exactly that when it happens.
- **Pages are collected by one worker rather than several** for a project that has the reader
  installed, which a large application will notice. `experimental.cpus` is yours to set if you would
  rather decide it yourself; a build that renders in several processes is one where all but the first
  find the storage taken.

Neither applies to a project that never reads storage: without `@stayingupwind/sdk` installed, a
build is exactly what it was.

It is a convenience, not a requirement. A project whose `next.config` names the adapter itself —

```ts
import { createRequire } from 'node:module';

export default {
  adapterPath: createRequire(import.meta.url).resolve('@stayingupwind/adapter'),
};
```

— gets the same bundle from a plain `next build`, from CI, or from any other tool that runs one.
What `upwind build` adds is that a project which has _not_ written that line still builds a bundle,
and that a project with no adapter installed is refused rather than left with a build that quietly
produced none.

## On Vercel

**`VERCEL` is set, so this command names nothing.** An adapter named in a build takes the deployment
over, and on Vercel the deployment is Vercel's: `next build` writes a bundle under `.arkor/` that
Vercel does not read, and — on Next.js 16.3, which is what this was measured against — stops writing
the file traces Vercel's own build does: `next-server.js.nft.json` and
`next-minimal-server.js.nft.json` are absent from `.next/` when an adapter is named, and written when
none is. So `upwind build` on Vercel does not name the adapter and publishes no storage for one; what
runs is the project's own `next build`, and a line says so, because a command that stops doing the one
thing it is for owes you the reason.

That is this command's half of it. The other half is the project's, and it is the half that decides:
**a `next.config` that names an adapter outranks anything the environment says**, including the
nothing this command now says on Vercel — so the block above, written unconditionally, produces a
bundle on Vercel too. A project that deploys to both writes it conditionally, and then one `build`
script serves both:

```ts
import { createRequire } from 'node:module';

const onVercel = process.env.VERCEL !== undefined && process.env.VERCEL !== '';

export default {
  ...(onVercel
    ? {}
    : { adapterPath: createRequire(import.meta.url).resolve('@stayingupwind/adapter') }),
};
```

`create-upwind` writes the unconditional line, so a scaffolded project is one edit away from this.

And `NEXT_ADAPTER_PATH` still wins, for the build that means it: a job that runs on Vercel to produce
a bundle rather than a Vercel deployment names the adapter in the environment and gets one.

## `upwind deploy`

```bash
CLOUDFLARE_API_TOKEN=… pnpm upwind deploy
```

The project, deployed to a Cloudflare account of your own: the edge in front, the runtime cache
behind it, and each deployment's Functions as Workers of their own, the edge switched to a new
deployment only once the new one answers. `--dry-run` builds the project, checks the build and the
account, and says what a deploy would make there, changing nothing.

- **The build is a deploy's own.** It is `upwind build` with the deployment's id chosen first, so
  that every asset carries it; with the runtime cache's host in every Function, named to the
  adapter through the environment, so that the project's `next.config` needs no change; and with no
  storage published while pages prerender: a deployment's pages are never rendered from a
  development database. `--build-only` builds and stops, for a job that holds no credentials;
  `--prebuilt` deploys what that build left, in a job that does.
- **Credentials come from the environment, never a flag.** `CLOUDFLARE_API_TOKEN`, and
  `CLOUDFLARE_ACCOUNT_ID` where the token reaches more than one account. They are taken out of the
  environment before the project's configuration or its build runs, so neither is handed them.
- **The project says what it is given.** Its `deploy` section, in `upwind.config.ts` (or
  `upwind.jsonc`, `upwind.json`), names the project on the account, the hostnames the edge is
  reached on beside `workers.dev`, how many deployments to keep for rolling back to, the storage
  every Function is bound to, and the secrets read from the environment on every deploy.
  `--env-file` adds a file's variables to those secrets. Nothing is guessed from the code: storage
  a project does not name is not made.
- **What would be wrong is refused before the account is changed**: a Function built without the
  runtime cache, a cron nobody would fire, more Workers than the account can hold beside the ones
  it has, an account with no `workers.dev` subdomain to reach. Each is said, and the run ends. A
  project that signs users in with no secret among its secrets is warned of, since its auth
  configuration may name one itself.
- **The account is on Workers Paid.** Its limits are the ones held to — 500 Workers an account,
  128 variables a Worker — and a deployment of a Next.js application needs them; on Workers Free,
  Cloudflare refuses at upload what goes past its lower ones.

```ts
import type { UpwindConfig } from '@stayingupwind/adapter';

export default {
  deploy: {
    name: 'shop',
    hostnames: ['shop.example.com'],
    storage: { UPWIND_D1: 'd1' },
    secrets: ['AUTH_SECRET'],
  },
} satisfies UpwindConfig;
```

### What a deploy makes, and how it goes live

For a project named `shop`, the account holds:

|                                                     | What it is                                                                                                                                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shop-edge`                                         | The edge. Each deployment is a version of it, with that deployment's pointer fixed in it, so nothing is read before a visitor's first byte that the version could have been given. On `workers.dev` unless `deploy.workersDev` is `false`. |
| `shop-<deployment>-app`, `-app-2`…, `-mw`           | Each deployment's Functions. On neither `workers.dev` nor a preview URL: only the edge reaches them.                                                                                                                                       |
| `shop-cache`, `shop-cache-read`, `shop-prefetch`    | The runtime cache's authority and read gateway, and the Worker a Function reads the files its build left out of it from. Reached by service bindings alone.                                                                                |
| `shop-agent`                                        | What a deploy writes the stores through, on `workers.dev`, answering only a key the running deploy set and discards when it ends. It writes only what a deployment's files are named by: their digests.                                    |
| `upwind:shop:edge-state`, `upwind:shop:cache-state` | KV namespaces: what the edge serves by, and the runtime cache's state.                                                                                                                                                                     |
| `shop-artifacts`                                    | The R2 bucket of every deployment's files, with a mark saying it is the project's. A deploy uses nothing of that name it did not make.                                                                                                     |

A deploy uploads the new deployment's Functions and a version of the edge that takes no traffic,
then asks that version, by name, which deployment it serves, and asks it for each of
`deploy.checks` (`/` by default). Only when it answers as itself, and no check answers with a 5xx,
is it given all the edge's traffic. Otherwise the version that was live stays live, and the run
says what failed. A deploy stopped part way can be run again: what it wrote is found again, under
its digest or the deployment's id. A deployment is what it was built as: deploying the live one
again changes nothing, so a new secret's value reaches the Functions with a new build.

The token needs, on the account: **Workers Scripts: Edit**, **Workers KV Storage: Edit**, **Workers
R2 Storage: Edit**, and **D1: Edit** where `deploy.storage` names a database. A custom domain is
attached to `shop-edge` by hand, in Cloudflare, and named in `deploy.hostnames`.

`upwind destroy --yes` deletes everything a deploy made for the project, its edge first. The storage
`deploy.storage` names holds the application's data, and is deleted only with `--include-storage`.

### Deployments, and going back to one

```bash
CLOUDFLARE_API_TOKEN=… pnpm upwind deployments
CLOUDFLARE_API_TOKEN=… pnpm upwind rollback [--to dpl_…]
```

- **`upwind deployments`** lists the project's deployments, the newest first: the live one, one
  held at none of the traffic while a run checks it, those a rollback can go back to, and those
  whose Functions are gone. It reads the account and changes nothing on it.
- **`upwind rollback`** gives the edge's traffic back to an older deployment — the one before the
  live one, or the one `--to` names — with nothing uploaded. It is checked first, as a new
  deployment is, and given the traffic only once it answers as itself and passes the project's
  checks; one that does not is given none.
- **What is kept.** Once a deployment is live, a deploy keeps it, every deployment the edge's
  traffic is with, and the newest `deploy.keep` others (`--keep`, for one run) a rollback can still
  go back to; the rest lose their Functions, and their scope of the runtime cache. Cloudflare keeps
  the newest hundred versions of the edge for a deployment to choose among, so nothing older can be
  gone back to, whatever is kept. Every deployment's files stay in the bucket.

## Options

```
upwind dev [directory]
upwind build [directory]
upwind deploy [directory] --dry-run

  -p, --port <port>      Port to listen on, `dev` only (default: $PORT, else 3000)
  -H, --hostname <host>  Hostname to bind, `dev` only (default: every interface)
      --remote-ai        Enable declared Workers AI bindings, `dev` only
      --dry-run          Say what a deploy would do and change nothing, `deploy` only
      --build-only       Build for a deploy and stop, `deploy` only
      --prebuilt         Deploy what --build-only built, `deploy` only
      --env-file <file>  Secrets for the deployment's Functions, `deploy` only; may repeat
      --keep <n>         Deployments kept to roll back to, `deploy` only (default: 5)
      --message <text>   What the deployment is noted as, `deploy` only
  -v, --version          Print upwind's version
  -h, --help             Print the usage
      --                 Everything after this is the directory, even `--help`
```

A port already in use moves up, up to ten times, as `next dev` does. `next dev`'s other flags —
`--experimental-https`, `--inspect`, `--turbopack`, `--webpack` — are refused rather than quietly
ignored; the bundler is Next.js's own default, which is Turbopack, and which is the only one
`@stayingupwind/adapter` can build. `next build`'s own flags are not forwarded either: a project that
needs one runs `next build` itself, with the `next.config` above.

## Licence

MIT or Apache-2.0, at your option.

## Local Durable Objects

Use the registrations exported by your host as `UPWIND_DURABLE_OBJECTS`, a JSON array of
`{ name, module, className }`. Modules are relative to the Next.js project directory. Both
`upwind dev` and `upwind build` use it; the corresponding adapter and SDK packages must support
Durable Objects.
Registrations may include the host's positive safe integer `definitionRevision`; local builds carry
it unchanged into deployment metadata so the host can validate the definition used for the build.

Each class runs in its own local Worker and gets a SQLite namespace persisted in `.upwind/`.
The namespace is published under its registered name, so `durableObject('COUNTERS')` and the
`@stayingupwind/sdk/durable-object` default import work as they do in the deployment. Namespace
startup does not instantiate objects. The first application invocation runs the class.

Editing a bundled class dependency restarts the dev server through the existing supervisor,
keeping persisted data. Updating the registration input requires restarting the command with the
new exported array. Deleting `.upwind/` also deletes the local objects' data.

If class bundling or native Worker startup fails, the CLI reports the error and keeps default D1,
KV and R2 storage available. The class sources stay watched so editing them restarts development.
Native startup errors naming a particular owner remove that owner while healthy namespaces remain
available; failures that cannot identify an owner fall back to the default storage.
Storage probe failures retain their original diagnostics and do not trigger owner recovery.
The watch also covers TypeScript aliases and package `imports`/`exports`, including targets or
dependency packages that have not been generated yet. If a
registration uses a default storage name, the default gets a unique local alias while its persisted
data and the SDK's default accessor stay available; the object's registered name is preserved.
