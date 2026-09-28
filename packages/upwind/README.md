# upwind

`upwind dev` runs a Next.js development server behind upwind's own front door.

```bash
pnpm add -D upwind
pnpm upwind dev
```

`upwind` alone is enough to serve an application and to answer `/__upwind`. A project that also has
`@stayingupwind/adapter` installed — which is what builds the deployment — gets the second half of the
arrangement below as well, where the prefix is reserved inside Next.js's own routing.

```
  upwind 0.2.0 dev
  - Local:     http://localhost:3000
  - Internal:  http://localhost:3000/__upwind

  ✓ Next.js 16.3.6 ready in 1127ms
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

The third thing that parent does is write `AGENTS.md` and `CLAUDE.md`. Run by an AI coding agent
against a project whose agent-rules block is missing or out of date, `next dev` writes the current
one — the block that says this major is not the Next.js the agent was trained on. `upwind dev` asks
the project's own Next.js to do exactly that, so the files say what that Next.js says, and
`agentRules: false` in `next.config` turns it off here as it does there.

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
  "upwind": "0.2.0",
  "next": "16.3.6",
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
bundle under `.ppr-cdn/` is `@stayingupwind/adapter`'s work and the build is Next.js's; what was
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

**`VERCEL` is set, so this command names nothing.** A build on Vercel is Vercel's: it produces what
Vercel serves, and an adapter named there would produce a deployment bundle instead — which Vercel
does not read, leaving it without the output it does. So `upwind build` on Vercel is the project's
own `next build` and nothing else: no adapter, no storage published for one, and a line saying so,
because a run of this command that writes no bundle owes you the reason.

That is what lets one `build` script serve both: the same commit deploys to a host that reads the
bundle and to Vercel, and neither needs its own command.

A project whose `next.config` names the adapter itself — the block above — has said something this
command cannot unsay, and will produce a bundle on Vercel too. A project that wants both writes the
line conditionally:

```ts
const onVercel = process.env.VERCEL !== undefined && process.env.VERCEL !== '';

export default {
  ...(onVercel
    ? {}
    : { adapterPath: createRequire(import.meta.url).resolve('@stayingupwind/adapter') }),
};
```

And `NEXT_ADAPTER_PATH` still wins, for the build that means it: a job that runs on Vercel to produce
a bundle rather than a Vercel deployment names the adapter in the environment and gets one.

## Options

```
upwind dev [directory]
upwind build [directory]

  -p, --port <port>      Port to listen on, `dev` only (default: $PORT, else 3000)
  -H, --hostname <host>  Hostname to bind, `dev` only (default: every interface)
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
