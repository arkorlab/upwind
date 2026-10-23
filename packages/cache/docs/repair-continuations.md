# Bounded artifact repair continuations

A shared artifact can be named by every current generation in a scope. Repairing it must not scan
those generations inside one SQLite transaction. Commit, seed retry and data-value repair now
persist a continuation and seek the next entry primary key before examining its current output.
One step materializes at most one generation; an alarm runs at most eight steps. Skipped and
nonmatching entries advance the same cursor.

## Admission, progress and recovery

An operation retains its accepted limits across a restart or deployment. A preflight visits the
same bounded entry windows before that repair group changes any shared snapshot. Legacy records
keep their existing pack ceilings; a temporary synchronous SQL update/restoration also probes the
provider row limit. A failed probe rolls back before a separate transaction records the refusal.
There is no additional admission cap. A refused seed retry leaves other fresh admissions and
previous successful retries intact.

The write queue protects the prepared operation, canonical location, failed-location incarnation
and reservations. Unrelated healthy render heartbeats can continue without advancing the scope
revision. An expired heartbeat keeps its existing refusal response; its expiry cleanup waits until after repair. This
keeps the future revision of each changed row predictable. A seed retry's initial eligibility is
frozen before those leases can expire; canonical choices and record-fit decisions still follow the
original retry order. Serving reads do not consult or wait for the job.

Preflight probes the actual provider row limit for both generation and entry metadata, including
the publishing rows. It uses the exact future revision for each matching row rather than a
conservative maximum integer. Repair timestamps retain the accepted operation time. A refused
group changes no shared snapshot; other fresh admissions and earlier seed retries remain intact.

During apply, current SQL snapshots progressively name the verified replacement. Public success
waits until every affected SQL snapshot and the final publishing generation are complete. This is
physical healing within an operation, with no serving-read epoch or shadow lookup. Normal bounded
KV projection follows publication; existing projection failure/retry behavior is retained.

An alarm is armed before durable job acceptance. Each step updates its cursor and snapshot in one
transaction. The durable result is available only after final publication. Failure-incarnation pins
keep an earlier projection from clearing a newer observation. Interrupted jobs resume from SQLite;
there is no timeout that silently drops an accepted repair.

## Fixed-width replacements and ownership

Only new scopes with the audited reader approval described in [repair-locators.md](repair-locators.md)
may produce compact version-two records. Existing scopes retain version one and their preflight
refusal behavior. No existing immutable Function is switched to a format it cannot decode.

Route uploads durably reserve a fresh fixed-width location before the gateway writes it. Retried
uploads reuse their reservation and require a matching positive provider checksum, size, scope
owner, namespace and attempt receipt. A negative HEAD never proves an older write has settled.
Unknown objects are left untouched; conditional-create collisions rotate the reservation for every
role of the same SHA together. A same-key rate limit is rescued only by a matching positive receipt.

Seed and data repairs stream a source into a separate create-once object and verify the provider's
checksum before accepting a publication job. A failed or uncertain private copy is never published;
it can remain an unreferenced object for the existing orphan-sweep lifecycle. These copies do not
have the route upload's attempt reservation. Borrowed seed copies retain borrowed quota accounting.
Cleanup identifies the actual stable Durable Object owner as well as its namespace, and preserves
live canonical references, attempts and repair pins. Prefix shape alone does not authorize deletion.
Periodic scans and retirement clean objects visible to those passes; they do not turn a negative
read into finality for an unknown in-flight provider write.

The fixed-width tuple proof keeps SQL and pack metadata from growing on version-two repairs. The
same already-verified scope identity selects sizing and serialization. No new network request,
capability probe, hash or metadata lookup is added to healthy serving reads.

## Verification

Regression cases cover skipped primary-key rows, transaction rollback, persisted-cursor restart,
near-limit refusals, failure-marker ABA, initial seed eligibility, ordered shared-SHA retries,
positive R2 receipts, unknown-object collisions and ownership-aware namespace cleanup. They run in
CI; local project test, lint, typecheck, build and benchmark gates are not run for this change.
