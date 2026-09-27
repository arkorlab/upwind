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
│   ├── upwind/    # upwind — the CLI; `upwind dev` runs a Next.js dev server behind its own door
│   └── create-upwind/
│                   # create-upwind — `pnpm create upwind`, and the application it writes
├── fixtures/      # applications built against each supported Next.js, one per runtime
├── tools/
│   └── next-matrix/  # builds those fixtures with each Next.js and checks what came out
└── .github/
    ├── workflows/ci.yaml           # every check, on every pull request
    ├── workflows/next-matrix.yaml  # the supported Next.js range, checked against Next.js itself
    ├── workflows/release.yaml      # where a release enters; npm's trusted publisher names this file
    ├── workflows/publish.yaml      # what a release does
    └── release-signers.asc         # the keys a release tag may be signed with
```

All five packages are published. The workspace root, `tools/` and `fixtures/` are not — and the
fixtures are deliberately outside the pnpm workspace, since a workspace package would be pinned to
the catalog's single Next.js, which is the one thing the matrix exists to look past.

## Development setup

Node 24 — the repository names `24.21.0` — and pnpm 12. You do not install pnpm yourself:
`packageManager` names the exact version, and Corepack fetches it. Corepack ships with Node but is
not on until you say so, which is the one step a fresh machine needs.

```bash
corepack enable          # once per machine; `pnpm` does not exist until this runs
git clone https://github.com/arkorlab/upwind.git
cd upwind
pnpm install

pnpm typecheck         # tsc across every package, then the root config
pnpm lint              # ESLint, type-aware, across every package
pnpm format            # oxfmt --check; `pnpm format:write` writes
pnpm knip              # unused files and unused dependencies
pnpm build             # type-checks core and runtime; bundles the adapter's published entry
pnpm check:patches     # every rewrite of Next.js's output still finds what it insists on
pnpm check:agent-rules # the agent rules `create-upwind` writes are still Next.js's own
```

Those seven, in that order, are exactly what CI runs — there is nothing else to pass. `pnpm lint` is
type-aware over the whole workspace and wants more than Node's default heap; CI gives it 8 GB
(`NODE_OPTIONS=--max-old-space-size=8192`), and you may need to as well.

**There is no test suite in this repository.** The checks above are the whole of CI, and some prose
in the package readmes refers to suites by path; those suites are not here. What _is_ checked against
something outside this repository is what this one matched against Next.js by text — the adapter's
rewrites of Next.js's own output, and the agent rules `create-upwind` copies from it — because text
goes stale silently:

| Command                  | What it does                                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check:patches`     | applies every patch to the installed Next.js. No network, a second or two, and part of CI. `--range` does it for every release the supported range admits        |
| `pnpm check:agent-rules` | has the installed Next.js write its own `AGENTS.md` and `CLAUDE.md`, and compares them byte for byte with what `create-upwind` writes. Instant, and part of CI   |
| `pnpm check:matrix`      | builds `fixtures/` with several Next.js versions and checks the bundle that came out. Minutes and a package download per version, so it runs on its own schedule |

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
  the prose here, however true it is elsewhere.
- **`knip` fails on an unused file or dependency.** Unused _exports_ are not checked and cannot be:
  every package here is a library whose readers are a host's own code, which is not in this
  repository.

## Releases

Maintainers only. The version of all five packages moves in lockstep, in a pull request like any
other; a tag is not a place to make a change. Once the bump is on `main`:

```bash
git switch main && git pull
# The name is `v` and the version every package now says — nothing else is accepted.
git tag -s v0.2.0 -m v0.2.0
git push origin v0.2.0
```

Everything else is in [`publish.yaml`](.github/workflows/publish.yaml). A release refuses a tag that
is not signed by a key in [`release-signers.asc`](.github/release-signers.asc), that does not stand
on `main`, or that names a version the packages do not — which is why the bump has to be merged
before the tag exists rather than carried by it. It publishes through npm's trusted publishing, with
a provenance attestation it reads back off the registry afterwards.

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
- **There is no suite to add to.** If your change fixes something you can demonstrate, the most
  useful thing you can include is how to see it: the `next build` that produced it, the route, and
  what was served instead.
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
