# Contributing to upwind

Thanks for looking. upwind is a Next.js deployment adapter and the runtime that serves what it
builds. Everything here is before `1.0`: the deployment bundle carries a version of its own and is
expected to change shape before it settles, and no release carries a compatibility shim for the minor
before it. Issues, questions and pull requests are all welcome.

## Ways to help

| Effort           | What's most useful                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **5 min**        | Read [what the adapter reads](packages/adapter/README.md) and [open an issue](https://github.com/arkorlab/upwind/issues/new) about anything that was wrong, missing, or true of your application and not of the document. |
| **An afternoon** | Pick up a [`good first issue`](https://github.com/arkorlab/upwind/labels/good%20first%20issue), or send a small PR — a clearer error message, a comment that names the failure it exists for, a doc fix.                  |
| **Ongoing**      | Tell us what your Next.js application does that this does not serve. A build we have never seen is the most useful thing you have.                                                                                        |

Three kinds of change are contracts with readers outside this repository: a field of the deployment
bundle, the project manifest an edge reads, and the `x-arkor-*` protocol between an edge and a
Function. Please open an issue before writing one of those, so the shape can be agreed first.

## Repo layout

```
upwind/
├── packages/
│   ├── core/      # @stayingupwind/core — the vocabulary the others speak: the bundle contract,
│   │              #   the cache's terms, request classification, the host↔application protocol
│   ├── adapter/   # @stayingupwind/adapter — runs inside `next build`, writes the bundle and
│   │              #   builds the Functions that serve it
│   ├── runtime/   # @stayingupwind/runtime — what a deployment's Function runs
│   ├── sdk/       # @stayingupwind/sdk — what an application reads its own storage through:
│   │              #   the D1 database, KV namespace and R2 bucket its deployment published
│   ├── auth/      # @stayingupwind/auth — Better Auth with nothing to configure: the config beside
│   │              #   the app is mounted, given that database, and signed in against upwind itself
│   ├── host/      # @stayingupwind/host — what an edge, its runtime cache and what deploys to them
│   │              #   share: the delivery policy, the pointer, the cache's contracts, storage keys
│   ├── deploy/    # @stayingupwind/deploy — what deploying a build assembles from it: the manifest,
│   │              #   the shells, the cache's seed, the Functions' bindings, the pointer
│   ├── cache/     # @stayingupwind/cache — a deployment's runtime cache: the authority that keeps
│   │              #   its scope, the gateways in front of it, and the client a Function reaches it with
│   ├── upwind/    # upwind — the CLI; `upwind dev` runs a Next.js dev server behind its own door
│   └── create-upwind/
│                   # create-upwind — `pnpm create upwind`, and the application it writes
├── fixtures/      # applications built against each supported Next.js, one per runtime
├── web-site/      # www.stayingupwind.com — the project's own site, in English and Japanese,
│                   #   written by create-upwind and built by the released upwind
├── tools/
│   ├── next-matrix/   # builds those fixtures with each Next.js and checks what came out
│   ├── deploy-tests/  # deploys Next.js's own deploy-mode applications to a host for its suite to run
│   └── vocabulary/    # holds the packages that serve and deploy a deployment to words any host uses
└── .github/
    ├── workflows/ci.yaml            # every check, on every pull request
    ├── workflows/next-matrix.yaml   # the supported Next.js range, checked against Next.js itself
    ├── workflows/deploy-tests.yaml  # that suite against a real host, which needs a credential
    ├── workflows/release.yaml       # where a release enters; npm's trusted publisher names this file
    ├── workflows/publish.yaml       # what a release does
    └── release-signers.asc          # the keys a release tag may be signed with
```

The packages under `packages/` are what a release publishes, and all of them move together — all
but a package whose manifest says `private`, which a release leaves out until it is ready to be
published for the first time.
The workspace root, `tools/`, `fixtures/` and `web-site/` are not —
and the fixtures are deliberately outside the pnpm workspace, since a workspace package would be
pinned to the catalog's single Next.js, which is the one thing the matrix exists to look past.

The site is outside it for a reason of its own: it depends on the _published_ `upwind` and
`@stayingupwind/adapter`, so what serves stayingupwind.com is a release rather than whatever is
uncommitted beside it. It has its own lockfile and its own install, `pnpm lint`, `pnpm knip` and
`pnpm typecheck` do not reach it, and `pnpm format` does. Its own readme says the rest.

## Development setup

Node 24 — the repository names `24.21.0` — and pnpm 12. You do not install pnpm yourself:
`packageManager` names the exact version, and Corepack fetches it. Corepack ships with Node but is
not on until you say so, which is the one step a fresh machine needs.

```bash
corepack enable          # once per machine; `pnpm` does not exist until this runs
git clone https://github.com/arkorlab/upwind.git
cd upwind
pnpm install

pnpm build                 # bundles every `dist` a release ships, in dependency order
pnpm typecheck             # tsc across every package, then the root config
pnpm lint                  # ESLint, type-aware, across every package
pnpm format                # oxfmt --check; `pnpm format:write` writes
pnpm knip                  # unused files and unused dependencies
pnpm check:patches         # the rewrites of Next.js's own package still find what they insist on
pnpm check:deploy-tests    # the deploy-mode hooks, against a host that is not one
pnpm check:durable-objects # native namespaces, SQLite storage and source isolation, without a build
pnpm check:ai              # the inference contract and local AI isolation, without a remote call
pnpm check:agent-rules     # the agent rules `create-upwind` writes are still Next.js's own
pnpm check:vocabulary      # the packages that serve and deploy a deployment name no host's own parts
pnpm test                  # every suite a package or a tool keeps, under one Vitest runner
```

All but the last, in that order, are what CI's `check` job runs; `pnpm test` is a job of its own
beside it. And beside both, `pnpm audit --audit-level low` over both lockfiles — this one and the
site's — so a pull request can also be stopped by an advisory against something neither of you
wrote.

**`pnpm build` comes first, and the order is not cosmetic.** `@stayingupwind/sdk` and
`@stayingupwind/auth` are read through the `dist` they are built into rather than through their
sources, since an application's own bundler reads them and neither can therefore name `src` in
`exports`. A sibling that imports one of them resolves it to declarations that do not exist until
`build` has run, so everything type-aware comes after it — and `pnpm -r` builds in dependency order,
which is also what proves that order is right. `pnpm lint` is type-aware over the whole workspace and
wants more than Node's default heap; CI gives it 8 GB
(`NODE_OPTIONS=--max-old-space-size=8192`), and you may need to as well.

**Suites are few.** `pnpm test` runs what a package or a tool keeps under its own `test/`, each in
the environment its `vitest.config.mts` names; beyond those, the checks above are the whole of it,
and some prose in the package readmes refers by path to suites that are not here. What _is_ checked
against something outside this repository is what this one matched against Next.js by text — the
adapter's rewrites of Next.js's own output, and the agent rules `create-upwind` copies from it —
because text goes stale silently:

| Command                  | What it does                                                                                                                                                                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check:patches`     | applies the rewrites that reach Next.js's published package to the installed Next.js. No network, a second or two, and part of CI. `--range` does it for every release the supported range admits                                                                           |
| `pnpm check:agent-rules` | has the installed Next.js write its own agent files into an empty directory, then compares their names and bytes with the files `create-upwind` writes. Instant, and part of CI                                                                                             |
| `pnpm check:matrix`      | builds `fixtures/` with several Next.js versions and checks the bundle that came out — including the four rewrites aimed at what `next build` _writes_, which no reading of a package can reach. Minutes and a package download per version, so it runs on its own schedule |

None of them is in your way on a normal change: the first two are the fast ones, and `check:matrix`
only matters if you touched `packages/adapter/src/patches/`. The patch checks are described in
[the adapter's readme](packages/adapter/README.md), under "Which Next.js".

## Style

- **oxfmt formats everything.** 100 columns for code. Comments and markdown run past it where the
  prose reads better, and plenty do — the formatter does not reflow them, and neither should you
  just to fit.
- **The em dash is house style here.** So are long sentences that say a whole thought.
- **Comments say why, not what.** This repository is unusually comment-heavy on purpose: a line
  naming the failure a workaround exists for, or the measurement behind a choice, outlives the code
  it sits above. A patch against Next.js's own output without that line is the thing that rots.
- **Say what the code does, not whose platform runs it.** These packages describe a Next.js build
  and the Function that serves it. A host's control plane, topology, or tenancy has no business in
  the prose here, however true it is elsewhere. The packages that serve and deploy a deployment are
  held to that by `pnpm check:vocabulary`, which names each word it refuses and says why
  ([`tools/vocabulary/src/terms.ts`](tools/vocabulary/src/terms.ts)).
- **`knip` fails on an unused file or dependency.** Unused _exports_ are not checked and cannot be:
  every package here is a library whose readers are a host's own code, which is not in this
  repository.

## Releases

Maintainers only. The version of every package moves in lockstep, in a pull request like any
other; a tag is not a place to make a change. A package published for the first time also gets a row
in `PACKAGES` in [`web-site/src/lib/site.ts`](web-site/src/lib/site.ts) — but **after** the release,
not in the bump: that table links to npm, the site deploys when a change lands on `main`, and the
bump lands there before anything is published. Once the bump is on `main`:

```bash
git switch main && git pull
# The name is `v` and the version every package now says — nothing else is accepted.
git tag -s v0.4.0 -m v0.4.0
git push origin v0.4.0
```

Pushing the tag is the whole of a release, for every release that publishes no new name. `verify`
refuses a tag whose packages include one npm has never heard of, unless the run was asked for a
credential that could publish it — which is a refusal and not a half-made release, and a tag push
cannot do the asking. The steps below are what to do when that is the release you are making.

Everything else is in [`publish.yaml`](.github/workflows/publish.yaml). A release refuses a tag that
is not signed by a key in [`release-signers.asc`](.github/release-signers.asc), that does not stand
on `main`, or that names a version the packages do not — which is why the bump has to be merged
before the tag exists rather than carried by it. It publishes through npm's trusted publishing, with
a provenance attestation it reads back off the registry afterwards.

**A package published for the first time takes one release that cannot come through there.** npm will
not hold a trusted publisher for a name that does not exist yet, and publishing such a name by hand
would leave a version no provenance covers — which the release after it fails over. The answer, four
times now, has been a temporary `bootstrap` input carrying a token for that one release and removed
again afterwards. `@stayingupwind/auth` is the name it is in the workflow for today, and the whole of
such a release is:

1. **A token, as small as npm will cut one.** Granular, **Packages and scopes → Read and write**,
   limited to the `@stayingupwind` scope, shortest expiry. **Organizations** is not publishing
   permission and buys nothing — and npm answers a token without rights `404 Not Found` rather than
   `403`, so the log reads as though the package does not exist. A new _unscoped_ name cannot be
   asked for this way at all, and needs a registry-wide token; a scoped one can, through its scope.
2. `gh secret set NPM_TOKEN`, pasted rather than passed on a command line.
3. **Dispatch** `Release` with the tag, `dry-run: false` and `bootstrap: true`. The tag still has to
   be pushed first — it is what the dispatch verifies — and **the run that push starts fails, by
   design**: a tag push cannot ask for a credential, so `verify` refuses it over the name npm has
   never heard of, having published nothing. That red run is the guard working. Let it finish — one
   release of a version runs at a time, so the dispatch queues behind it — and the dispatch then
   verifies the same tag the same way and is the release.
4. **Approve the `release` environment.** That gate is the last human checkpoint before something
   that cannot be taken back.
5. **Give the new name a trusted publisher of its own, now that it exists**, so the release after
   this one needs none of the above:

   ```bash
   npm trust github @stayingupwind/auth \
     --file release.yaml --repository arkorlab/upwind \
     --environment release --allow-publish
   ```

   npm 11.15 or later, and it asks for an OTP. `--file` is the **caller's** filename, because npm
   validates the OIDC token's `workflow_ref` and not `job_workflow_ref`.

6. `gh secret delete NPM_TOKEN` and revoke the token. Then two follow-ups: take the `bootstrap`
   input back out, and — now that the name is on npm — give it its row in `PACKAGES` and move this
   project's own pin to the release that is out.

Step 5 is the one with no check behind it. By the next release the name exists, so `verify`'s probe
is satisfied and a publish with no trusted publisher behind it fails partway instead — `npm trust
list` needs an OTP, so nothing in CI can read whether the grant is there. It is a step to finish in
the same sitting as the release, not one to leave for later.

The last thing it does is draft a GitHub Release for the tag. Notes written; the tarballs npm is
serving attached, each checked against the digest npm published beside it; and a bill of materials
for what they carry, in both formats `pnpm sbom` emits. Then it stops. A release here cannot be
changed once it is published, so the draft is made complete and the button stays a person's.

Two things are load-bearing and easy to break by tidying: the **filename** `release.yaml`, which
npm's trusted publisher is configured with, and the `release` environment the publishing job
declares, which npm requires as a claim.

## Pull request guidelines

We would rather read a rough PR than not see it. Tiny ones — a typo, a smoother sentence, a clearer
error — are genuinely welcome. Please don't let any of this stop you:

- **Size doesn't matter.** A large diff is fine. We would much rather split it up on our side than
  have you sit on it.
- **A sparse description is OK.** We will ask follow-ups in review rather than bounce the patch.
- **A test is welcome, not required.** Where the package you changed has suites, one that fails
  without your change says it best. Elsewhere, if your change fixes something you can demonstrate,
  the most useful thing you can include is how to see it: the `next build` that produced it, the
  route, and what was served instead.
- **Breaking changes are fine** before `1.0`, including to the bundle. Say so in the description —
  a host reads these fields, and a release note that stays honest is worth more than a shim.

## Reporting bugs and security issues

- **Bugs**: [GitHub Issues](https://github.com/arkorlab/upwind/issues/new). Your Next.js version,
  the relevant `next.config`, and what was served instead of what you expected go a long way; a
  one-line "this is broken" still beats not reporting it. If we cannot reproduce it we will ask on
  the issue — most stalled bugs are waiting on context only the reporter has.
- **Security**: please email security@arkor.ai rather than filing a public issue. We will
  acknowledge within 48 hours.

## Code of conduct

Be kind, assume good faith, and keep technical disagreement technical. Anything else — harassment,
personal attacks, exclusionary behaviour — is grounds for being asked to leave. The maintainers'
call is final.

## License

By contributing, you agree that your contributions will be published under this repository's terms:
[MIT](LICENSE-MIT) or [Apache 2.0](LICENSE-APACHE), at the recipient's option, with the
[NOTICE](NOTICE) that Apache 2.0 asks be passed along. Opening a pull request is deemed to
constitute this agreement.

What a later release is licensed under may change. This file does not ask you to agree to that in
advance: what you grant by opening a pull request is the two licenses above, and nothing beyond
them.
