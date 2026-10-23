# GitHub Actions benchmark

The same public application, [`web-site`](../../web-site), measured at
<https://stayingupwind.vercel.app/> and <https://www.stayingupwind.com/>. GitHub hosts the
Ubuntu runner on Azure, separately from the two platforms. This is another network vantage, not
a guarantee that its results represent every visitor. Its geographic region is not guaranteed.

## Repeat a measurement

Node **24.22.1**, with no dependency install, platform credential or build:

```sh
node tools/benchmark/src/main.ts > measurement.json
```

This command labels its output `vantage: "local"`. The Actions invocation explicitly selects
`"github"`, and only completed scheduled main-branch attempts can enter the public feed.

The [Benchmark workflow](../../.github/workflows/benchmark.yaml) runs on `ubuntu-24.04` every six
hours, at 00:43, 06:43, 12:43 and 18:43 UTC, and can also be dispatched manually. A scheduled run
can be delayed or dropped by GitHub. Public repositories' schedules can be disabled after sixty
days without activity. The measurement and publication queues serialize their respective work
without cancelling earlier observations.

## What is timed

Protocol **2** sends `GET /` with the same browser-navigation headers to both deployments, without
cookies or query strings. The user agent identifies the benchmark. Redirects are recorded and
never followed. Request headers and fixed settings are in [`src/protocol.ts`](src/protocol.ts).

Each scenario performs twenty warm-up requests per side, then thirty pairs. Vercel goes first in
even-numbered pairs, Arkor in odd-numbered pairs, starting at zero. There is one request in flight,
with 25 ms between requests, a four-second deadline for the entire request, and a sixteen-second
scenario budget. Warm-up samples are discarded. If the budget ends after one half of a pair, the
other half is recorded as not made; the slow half is not silently dropped.

- **New connection:** HTTP/1.1 with keep-alive and TLS session caching disabled. Every request opens
  its own TCP connection and performs its own TLS handshake. DNS lookup time is included, but OS
  and upstream DNS caches are not cleared.
- **Reused connection:** HTTP/1.1 with one persistent connection per target. A server may close it;
  each sample records `request.reusedSocket`, so a new socket cannot be mistaken for reuse.

`headersMs` times the final response headers, excluding interim 103 Early Hints. `firstByteMs`
times the first body chunk; `completeMs` times the body's end. An empty successful body's first
byte time is its completion time. Body errors preserve milestones already reached. Body bytes
are the encoded bytes received, without decompression or retaining response bodies.

Samples keep status, errors, actual connection reuse, DNS/TCP/TLS durations, content encoding,
response PoPs, mitigation markers and cache markers. No cookies or arbitrary response headers are
published. This measures the deployments at the recorded times. The source SHA identifies the
measurement code; it does not independently establish either deployment's revision. Measurements
do not deploy or modify the targets, and no platform-specific request option changes either side.

## Public results

The workflow attempts to upload `benchmark-attempt-<runAttempt>` as an Actions artifact for ninety
days when the measurement file exists. Missing artifacts are recorded by the completion finalizer.
Where a measurement fails after making samples, its attempted raw run stays in that artifact.
Manual dispatches, including branches and tags other than `main`, produce artifacts only and never
alter the scheduled series. Their artifacts retain the actual ref; canonical feed entries always
come from `refs/heads/main`.

The separate [Publish benchmark workflow](../../.github/workflows/benchmark-publish.yaml) runs
after completion, including cancellation or timeout. It executes code from trusted `main`, checks
the exact repository, workflow path, main branch and scheduled event, and treats the artifact as
JSON data. It records a failure if the artifact is missing, malformed or from another attempt.
Only this finalizer has permission to write the public `benchmark-results` branch. Both workflows
must be merged into the default branch before scheduled publication is active.

The anonymous JSON feed is
[`benchmark-results/index.json`](https://raw.githubusercontent.com/arkorlab/upwind/benchmark-results/index.json).
It has `schemaVersion: 1`, a monotonically increasing `sequence`, `publishedAt`, and an `attempts`
array in ascending publication sequence. Each attempt contains:

- `sequence`, decimal string `runId`, integer `runAttempt`, `startedAt`, `finishedAt`;
- `protocol`, the exact `targets`, and `source` containing repository, workflow path, ref, SHA,
  run URL and observed runner OS, architecture, image OS, image version and Node version;
- `status: "success"` and `result: "runs/<runId>-<runAttempt>.json"`, or `status: "failure"` and a
  bounded error. A cancellation before upload has `"unavailable"` for unobserved image/Node data.

A result is `{ schemaVersion: 1, runId, runAttempt, run }`; the run includes settings, paired
samples and `vantage: "github"`, with `location: null`. The branch retains the latest 120 successful
runs and at most 3,000 failures since the oldest retained success, or the latest 3,000 failures
before any success. The publication counter never resets when records are pruned. Reprocessing
an already retained workflow attempt leaves its record and counter unchanged. Corrupt existing
feed data causes publication to fail rather than resetting that counter.

A backwards local wall-clock interval cannot be published as a successful run. Its failure
envelope keeps ordered timestamps while the downloadable raw run preserves the observed wall
times; per-request durations use the monotonic performance clock.

Readers should validate the schema, exact targets and protocol; retain their previous valid
snapshot on a read failure; and use publication sequence rather than runner clocks to import new
observations. The source is public, and raw samples permit independent analysis.

## Validation and primary sources

`pnpm --filter @upwind-tools/benchmark test` checks request milestones, deadlines, pairing,
budget truncation, publication identity/order/retention, and the completion finalizer's trust
checks. These tests make no requests to either deployment.

- [Node.js HTTP: agents, actual reuse, final response events and timeout semantics](https://nodejs.org/download/release/latest-v24.x/docs/api/http.html)
- [Node.js HTTPS: TLS session caching](https://nodejs.org/download/release/latest-v24.x/docs/api/https.html)
- [GitHub-hosted runner infrastructure](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [GitHub scheduled event behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [GitHub workflow-run security](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [GitHub artifact downloads and retention](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)
