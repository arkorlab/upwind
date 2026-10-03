# `@upwind-tools/deploy-tests`

Runs Next.js's own deploy-mode test suite against this adapter, by deploying each test application to a
host over that host's public API and letting the host serve it.

This is the only honest way to run that suite against an adapter. What the adapter produces is a
deployment bundle; serving one — its static files, its prerendered shells, the routing in front of the
Function — is the host's half of the contract. A harness that stood the bundle's Function up on its own
would answer `404` for every `/_next/static/…`, and a page without its chunks never hydrates: measured
on a host's private harness, 240 of 944 suites failed for that one reason and nothing else. So a real
deployment it is.

The lifecycle is the
[documented contract](https://nextjs.org/docs/app/api-reference/adapters/testing-adapters): three
scripts, named to the suite through `NEXT_TEST_DEPLOY_SCRIPT_PATH`,
`NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH` and `NEXT_TEST_CLEANUP_SCRIPT_PATH`. Nothing in the suite is
modified and no expectation of theirs is rewritten: their `test/deploy-tests-manifest.json` decides
which suites deploy mode selects.

## What it needs

| Variable                      | What it is                                                             |
| ----------------------------- | ---------------------------------------------------------------------- |
| `ARKOR_API_URL`               | The host's public API, for example `https://api.example.com`           |
| `ARKOR_API_TOKEN`             | A token of that host with the `write` scope                            |
| `ARKOR_API_TOKEN_FILE`        | Or a file holding that token, read instead of the variable             |
| `ADAPTER_TEST_PROJECT_ID`     | A project on that host, **used by nothing else**                       |
| `ADAPTER_TEST_SETTLE_SECONDS` | Seconds waited once per fixture, before its suite starts; `0` if unset |

The names are the host's own, so that the script an operator already drives this suite with drives this
too. Nothing is passed on a command line, which is in every process list on the machine.

**The suite is somebody else's code, on the machine that holds the credential.** It is Next.js's
repository at a ref the run chose, and its applications' `package.json` scripts are run by the deploy
hook. So: the hook runs a fixture's install and build with these variables removed, the workflow keeps
the token in a file and gives the suite only its path, and `nextjsRef` should name a tag. None of that
is a boundary — a fixture's build and the deploy hook are the same user on the same machine, and a
process can read what another process of its own user can. What it removes is the ordinary way a secret
escapes, which is something printing the environment it was handed. So use a credential whose loss is
survivable: one project's worth of write access, rotatable, and nothing else.

**The project has to be dedicated.** Each fixture's deployment _replaces_ the project's whole runtime
environment with that fixture's own, so a project anything else uses would have its environment taken
out from under it. Create one however the host creates projects — its public API deploys into a project
and does not make one.

## Running it

```console
$ pnpm --filter @stayingupwind/adapter build     # the suite tests dist, as a project would
$ pnpm test:deploy preflight
```

`preflight` answers whether a run would get as far as its first deployment, without making one: the
configuration, that the project is served somewhere public, and that the token may write. The last is
proved by reading the project's environment and putting the same environment straight back — a no-op by
the API's own definition, since a secret reads back as `null` and `null` put back keeps the stored
value. A fixture is minutes of building before the first call to the API, so a token that cannot write
is worth learning about first.

Then, from a checkout of Next.js that has been built (`pnpm install && pnpm build && pnpm install`, and
`pnpm playwright install --with-deps chromium`):

```console
$ NEXT_TEST_MODE=deploy \
  NEXT_EXTERNAL_TESTS_FILTERS=test/deploy-tests-manifest.json \
  ADAPTER_DIR=/path/to/upwind \
  NEXT_TEST_DEPLOY_SCRIPT_PATH=$ADAPTER_DIR/tools/deploy-tests/scripts/e2e-deploy.sh \
  NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH=$ADAPTER_DIR/tools/deploy-tests/scripts/e2e-logs.sh \
  NEXT_TEST_CLEANUP_SCRIPT_PATH=$ADAPTER_DIR/tools/deploy-tests/scripts/e2e-cleanup.sh \
  node run-tests.js --type e2e -c 1 --retries 0 \
    test/e2e/app-dir/app-simple-routes/app-simple-routes.test.ts
```

`.github/workflows/deploy-tests.yaml` is the same thing on a runner, dispatched by hand. Its `tests`
input takes upstream paths, or `all` for everything the manifest allows; `shards` cuts `all` into that
many pieces (upstream's own `-g n/total`), and `only` runs one piece on its own, for taking a slice again
after it was cut short.

**Queueing behind one project, a full run is bounded by two of GitHub's limits at once**, and they pull in
opposite directions. The manifest selects around 1,100 suites, about six hundred of which deploy — the
rest declare `skipDeployment` upstream and pass in a couple of seconds. A shard runs for `total / n` plus
about three minutes of its own setup, and must stay under the 6 hours a job may execute; the last shard
waits for the other `n - 1` of those, and must start within the 24 hours a job may sit in the queue before
it is cancelled. Measured: a full pass in six shards took 11h41m, about two hours a shard, the last one
starting nine and three-quarter hours in — which is why the default is `6`, with room on both sides.

A settle is paid by every deploying suite: at its one-minute ceiling, about six hundred minutes across the
run, a hundred or so a shard — about four hours a shard at most, at six, still inside both limits.

Given a project per shard, none of that applies: the jobs all start at once, the queue limit never comes
near, and the run is one shard long. That is the section below, and it is the answer for a run much longer
than the measured one rather than a different number of shards.

Without a host at all, `pnpm check:deploy-tests` runs the three hooks against a fake one: a fake
application, a fake API, and the real scripts. It is what CI runs, and what keeps the shell contract
(standard output, which variables a fixture's scripts can see, which file the build id comes from) and
the order of the calls from breaking quietly between runs against a real host.

**Serially, `-c 1`.** One project takes one fixture at a time, because a deployment replaces the
project's environment and changes which deployment its requests reach; a second fixture deploying while the
first is under test makes the _first_ fail, for a reason nothing in its own output explains. The deploy
hook refuses rather than let that happen, and says which application holds the project.

**Parallelism is bought with projects, one per shard.** `ADAPTER_TEST_PROJECT_IDS` holds them, separated
by whitespace, and the count is how many shards the workflow runs at once — a shard takes the id at its
own position, so nothing is pooled and no two shards share a project. Fewer ids than shards is a slower
run rather than a broken one: the extra shards queue behind the ids that exist. Six projects turn a
day-long serial run into an afternoon, and they are made on the dashboard, since the public API deploys
into a project and does not create one.

**That refusal is one machine's.** The claims are files in the machine's own temporary directory, so a
run on a laptop and a dispatched workflow run cannot see each other, and the API has nothing to hold a
lock in. Between runners the rule is the workflow's `concurrency` group; between a runner and a terminal
it is whoever dispatched them. If two must overlap, give the second its own project.

## What the numbers do and do not mean

A run is an inventory of observed compatibility, not an assertion that every feature is supported.
Beyond that, four limits are worth knowing before reading a failure as this adapter's:

- **A fixture's environment is its own `.env` files, and only those.** A host's private harness can do
  better — it starts the deploy hook itself, so it can tell a variable the suite's harness passed
  through the process environment from one the machine already had. Here the suite starts the hook
  directly and there is no such baseline, so a suite whose application reads a variable that arrives
  only that way will fail. Guessing would be worse: it would hand a deployed Function whatever the
  terminal happened to hold.
- **No runtime logs.** The API serves a built deployment's build log, and an uploaded deployment has
  none, so what the logs hook shows is the build and the deployment. A suite that asserts on server
  output may fail for want of it.
- **Which deployment answered is proved by an asset, where one can prove it.** A `HEAD` for one of the
  bundle's static files, with its digest as the expected `ETag` — one whose answer the build's own
  routing would not have decided, since a middleware matcher, a redirect or rewrite ahead of the
  filesystem, or a `headers()` rule that sets `ETag` would each leave the host answering correctly with
  something that is not that digest. Which of them apply to the probe's own request is asked of the
  host's own `middlewareApplies`, so a rule conditioned on a header the probe does not send does not
  disqualify an asset. A path carrying the build id is preferred, because it is the one digest another
  deployment cannot have: the public endpoint exposes no deployment id, so where the only candidate is a
  content-addressed asset — shared across deployments on purpose — or an unchanged `public/` file, the
  digest is evidence that the file is served and not that this deployment served it. The log says which
  of the two it had.
  Where the build has no such file, the host's own account of which deployment is current is the whole
  of the evidence, and then any answer at all — including a `5xx`, which a route-only application may
  mean — counts as served. Both cases say so in the log. A redirect is the one answer that can never
  become the digest, so it is given thirty seconds — a host can name the new deployment before every part
  of it has caught up, and what answers in between is the previous fixture, which may redirect everything — and
  then said plainly: a project that is access-protected, or something in front of it redirecting static
  files, rather than a quarter of an hour of polling.
- **A request that reached the new deployment proves that it did, and no more.** A host that brings a
  deployment in place by place can answer the probe with the new one and the suite's next request with
  the one before — seen in a full run, where pages a suite received carried Next.js's own `data-dpl-id`
  naming an earlier fixture's deployment while other requests of the same suite reached their own. How
  long that lasts is the host's to know, so it is the operator's to say: `ADAPTER_TEST_SETTLE_SECONDS`
  is waited out in full before the suite starts, from the first request this deployment is known to have
  answered: the application's own page, whose `data-dpl-id` is waited on while it still names the
  deployment before. Not the probe's file — a file is at best this build's, and two deployments of one
  build share all of them (the same fixture deployed again, or a constant `generateBuildId`). Not from the host naming
  the deployment, because a host may name one before the switch has reached any request; and where no
  page names a deployment either, the probe is the best there is and the log says so. It is paid once
  per fixture, so it is worth setting to the host's real bound rather than to a round number above it,
  and it stops at a minute: around six hundred of the manifest's suites deploy, and a minute each is as
  much as the workflow's default split has room for. A host that takes longer than that to bring a
  deployment in everywhere is not one this setting can serve — more projects shorten the queue, not the
  wait. The page is asked for only when a settle is set, and is a request the application's own tests did
  not make: a fixture whose tests count its first visit may see one more.
- **The Next.js under test must be inside `SUPPORTED_NEXT_RANGE`.** Outside it the host refuses every
  deployment, and the suite reports every suite as failed for a reason that has nothing to do with the
  test. Inside it, 16.2 does without the content-addressed `/_next/static/immutable/*` — it ignores the
  option the adapter sets, while still marking files `immutable` for caching — and the deploy hook
  reports that as it finds it: the marker the harness reads is whether the bundle has a file under that
  path, not a constant.

Deployments are left in place. The API has no delete, and a host retires what a later deployment
replaces; the cleanup hook gives the project back and nothing else.

One environment note, from a machine that needed it: where IPv6 is advertised but unreachable, every
call waits out the happy-eyeballs attempt first.
`NODE_OPTIONS=--network-family-autoselection-attempt-timeout=2000` is what made it bearable.
