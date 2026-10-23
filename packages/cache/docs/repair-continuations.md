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
revision. An expired heartbeat keeps its existing refusal response; its expiry cleanup waits until
after repair. A seed retry's initial eligibility is frozen before those leases can expire;
canonical choices and record-fit decisions still follow the original retry order. Serving reads do
not consult or wait for the job.

Every continuation uses the original operation revision and accepted operation time. It does not
consume another revision for each matching entry or retry. This preserves the original integer
widths even when an accepted row lies exactly at the provider limit. Preflight probes the actual
publishing SQL transaction and host history append, including new generations, superseded rows,
entry metadata and scope counters. A success sentinel leaves the outer transaction to roll every
candidate write back before the next phase is persisted separately. Initial fresh seed events are
probed before any fresh row or durable job is accepted. No nested transaction or savepoint is used.
A refused group changes no shared snapshot; other fresh admissions and earlier seed retries remain
intact.

The preflight does not reject an otherwise accepted publication because a later KV acknowledgment
might exceed a SQL row limit. The existing protocol can accept the publication while its delivery
projection fails; that failure remains owed to the existing projection retry path. The change adds
no speculative acknowledgment admission condition.

During apply, current SQL snapshots progressively name the verified replacement. Each existing
entry retains its earlier delivery `record_revision`, and a fresh entry retains zero, until all
repair groups and their own publications finish. A bounded primary-key pass then releases affected
delivery revisions to the one original revision. No later group can rewrite an already released
snapshot. In particular, a direct `currentRecord(afterRevision)` reader cannot receive an
intermediate replacement at the final revision and then miss a later same-revision repair. Reads
keep using their existing generation/revision check, with no serving epoch or shadow lookup.

The job keeps the last history event for each entity type, entity ID and event kind, preserving its
first-occurrence order just as the original transaction's final-state deduplication does. Event
identities and payloads use bounded durable metadata chunks; a custom host that does not keep
regeneration records still receives its events. `NO_HISTORY` stores no event identities or payloads.
After physical healing and delivery-revision release, one final event is appended to the actual
host history per step. History export and its consumers also use bounded parts/pages rather than
materializing every event at this shared revision in one call. A host reports successful partial
export progress so the alarm continues immediately.

Public success waits until every affected SQL snapshot, publishing generation, final delivery
revision and final history append are complete. Normal bounded KV projection follows publication;
existing projection failure/retry behavior is retained. An alarm is armed before durable job
acceptance. A failure discovered after asynchronous seed planning first rolls the complete candidate
transaction back. Only then does its rare continuation drain older projection, arm an alarm and
probe the initial host events before retrying acceptance; healthy seeds gain no extra storage lookup.
Each step updates its cursor and snapshot in one transaction. Failure-incarnation pins
remain until the bounded finalization has finished, so an earlier projection cannot clear a newer
observation. Interrupted jobs resume from SQLite; no timeout silently drops an accepted repair.

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
near-limit acceptance and refusals, initial-history rollback, same-entry multi-SHA delivery cursors,
failure-marker ABA, initial seed eligibility, ordered shared-SHA retries,
positive R2 receipts, unknown-object collisions and ownership-aware namespace cleanup. They run in
CI; local project test, lint, typecheck, build and benchmark gates are not run for this change.
