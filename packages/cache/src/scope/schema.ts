/**
 * The authority's tables: one SQLite database per scope, inside its Durable Object.
 *
 * What is mutable state (an entry's current generation, a tag's last invalidation, a lease) lives
 * beside what is immutable once written (a generation, an invalidation record, an attempt's
 * outcome); the two are joined by ids, never copied into one another. Every change is committed
 * at one scope-wide `revision`, and what must happen after the commit — the delivery record in KV,
 * and whatever a host's history owes — is queued in these same tables (`entries.record_revision`
 * against `kv_revision`, and the history's own) so that a failure past the commit is retried from
 * what the commit left, not lost.
 */

/** Applied in order (`applySchema`); each statement is idempotent. */
const STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS scope (
    scope_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    key_schema_version INTEGER NOT NULL,
    build_id TEXT NOT NULL,
    status TEXT NOT NULL,
    seeded_at INTEGER NOT NULL,
    retired_at INTEGER,
    revision INTEGER NOT NULL,
    entry_count INTEGER NOT NULL,
    body_bytes INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS entries (
    entry_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    route TEXT,
    pathname TEXT,
    cache_key_digest TEXT NOT NULL,
    group_instance_id TEXT,
    key_descriptor TEXT NOT NULL,
    handler TEXT,
    created_at INTEGER NOT NULL,
    created_revision INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    record_revision INTEGER NOT NULL,
    kv_revision INTEGER NOT NULL,
    current_generation_id TEXT,
    publication TEXT NOT NULL,
    regeneration TEXT NOT NULL,
    regeneration_attempt_id TEXT,
    failed_count INTEGER NOT NULL,
    next_retry_at INTEGER,
    tombstone_revision INTEGER,
    committed_at INTEGER,
    updated_at INTEGER NOT NULL,
    fencing_max INTEGER NOT NULL,
    seq_max INTEGER NOT NULL
  )`,
  // The entries whose delivery record is behind, in the two orders settle reads them in: a
  // change's own, by the revision it committed at, and the backlog, least recently written first.
  `DROP INDEX IF EXISTS entries_kv_pending`,
  `CREATE INDEX IF NOT EXISTS entries_kv_pending_order
    ON entries (record_revision, entry_id) WHERE kv_revision < record_revision`,
  `CREATE INDEX IF NOT EXISTS entries_kv_backlog
    ON entries (kv_revision, entry_id) WHERE kv_revision < record_revision`,
  `CREATE TABLE IF NOT EXISTS generations (
    generation_id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    source TEXT NOT NULL,
    attempt_id TEXT,
    cache_timestamp INTEGER,
    produced_at INTEGER,
    policy TEXT NOT NULL,
    status INTEGER NOT NULL,
    headers TEXT NOT NULL,
    tags TEXT NOT NULL,
    dependency_coverage TEXT NOT NULL,
    dependency_revision INTEGER NOT NULL,
    publication TEXT NOT NULL,
    published_revision INTEGER,
    superseded_revision INTEGER,
    condemned TEXT,
    storage TEXT NOT NULL,
    pruned_at INTEGER,
    body_bytes INTEGER NOT NULL,
    producer TEXT,
    outputs TEXT NOT NULL,
    committed_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS generations_by_entry ON generations (entry_id, seq)`,
  // The latest write of each writer an entry has had (`data.ts`): a writer's write that arrives
  // after one it handed over later is not published. Kept for an hour (`WRITER_MARK_WINDOW_MS`),
  // and swept by retention past that — not with the entry, whose id a write recreates.
  `CREATE TABLE IF NOT EXISTS writer_marks (
    entry_id TEXT NOT NULL,
    writer TEXT NOT NULL,
    seq INTEGER NOT NULL,
    generation_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    marked_at INTEGER NOT NULL,
    PRIMARY KEY (entry_id, writer)
  )`,
  `CREATE INDEX IF NOT EXISTS writer_marks_by_age ON writer_marks (marked_at)`,
  `CREATE TABLE IF NOT EXISTS tags (
    tag_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    revision INTEGER NOT NULL,
    stale_at INTEGER,
    hard_expire_at INTEGER,
    meaning TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS tags_by_revision ON tags (revision)`,
  `CREATE TABLE IF NOT EXISTS entry_tags (
    tag_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    PRIMARY KEY (tag_id, entry_id)
  )`,
  `CREATE INDEX IF NOT EXISTS entry_tags_by_entry ON entry_tags (entry_id)`,
  // Resource changes and their warm jobs survive a lost response — to whatever dispatches the jobs,
  // or from the Function it asks. They are private authority state, independent of any history a
  // host keeps and of entry regeneration.
  `CREATE TABLE IF NOT EXISTS resource_heads (
    resource_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    tag TEXT NOT NULL,
    tag_revision INTEGER NOT NULL,
    applied_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS resource_warm_jobs (
    job_id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    required_revision INTEGER NOT NULL,
    status TEXT NOT NULL,
    attempt_count INTEGER NOT NULL,
    retry_at INTEGER NOT NULL,
    lease_token TEXT,
    lease_expires_at INTEGER,
    detail TEXT,
    updated_at INTEGER NOT NULL,
    UNIQUE (resource_id, entry_id)
  )`,
  `CREATE INDEX IF NOT EXISTS resource_warm_jobs_due
    ON resource_warm_jobs (retry_at, job_id) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS resource_warm_jobs_leases
    ON resource_warm_jobs (lease_expires_at, job_id) WHERE status = 'leased'`,
  `CREATE TABLE IF NOT EXISTS dependencies (
    owner_generation_id TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    observed_revision INTEGER,
    evidence TEXT NOT NULL,
    usage TEXT NOT NULL,
    PRIMARY KEY (owner_generation_id, target_kind, target_id)
  )`,
  `CREATE TABLE IF NOT EXISTS invalidations (
    invalidation_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    target_value TEXT,
    stale_at INTEGER NOT NULL,
    hard_expire_at INTEGER,
    meaning TEXT NOT NULL,
    expire_seconds INTEGER,
    cause TEXT NOT NULL,
    recorded_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS invalidations_by_target
    ON invalidations (target_kind, target_id, revision)`,
  // By when each took effect: what a data write made before some of them asks (`dataCondemnation`).
  `CREATE INDEX IF NOT EXISTS invalidations_by_target_stale
    ON invalidations (target_kind, target_id, stale_at)`,
  // And across every target: what an edge is told moved recently (`recentDelta`). A scope keeps
  // every invalidation it ever recorded, and the window holds few of them.
  `CREATE INDEX IF NOT EXISTS invalidations_by_stale_at ON invalidations (stale_at)`,
  `CREATE TABLE IF NOT EXISTS attempts (
    attempt_id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL,
    fencing_token INTEGER NOT NULL,
    dependency_revision INTEGER NOT NULL,
    lease_expires_at INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    generation_id TEXT,
    error TEXT,
    producer TEXT,
    observation TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS attempts_by_entry ON attempts (entry_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS attempts_leased
    ON attempts (lease_expires_at) WHERE status IN ('leased', 'uploading')`,
  // By when each ended: what retention ages out of a scope's history (`ageOutHistory`), which keeps
  // the attempts that ended for as long as the history is kept, and may hold millions of them.
  `CREATE INDEX IF NOT EXISTS attempts_by_finished_at ON attempts (finished_at)`,
  `CREATE TABLE IF NOT EXISTS attempt_artifacts (
    attempt_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    role TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    encoding TEXT NOT NULL,
    storage_ref TEXT NOT NULL,
    uploaded_at INTEGER NOT NULL,
    PRIMARY KEY (attempt_id, sha256, role)
  )`,
  `CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    storage_ref TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    owned INTEGER NOT NULL,
    refs INTEGER NOT NULL,
    referenced_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS attempt_artifacts_by_storage_ref
    ON attempt_artifacts (storage_ref)`,
  `CREATE INDEX IF NOT EXISTS artifacts_by_storage_ref ON artifacts (storage_ref)`,
  `CREATE TABLE IF NOT EXISTS quota_windows (
    window_start INTEGER PRIMARY KEY,
    attempts INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS pending_deletions (
    storage_ref TEXT PRIMARY KEY,
    queued_at INTEGER NOT NULL
  )`,
  // Oldest first, a page at a time (`pendingDeletions`): deletes storage keeps refusing pile up here,
  // and each run reads only the page it asks again for.
  `CREATE INDEX IF NOT EXISTS pending_deletions_by_age ON pending_deletions (queued_at, storage_ref)`,
];

/**
 * Whether the object holds a scope's tables: none until it is seeded, and none once retention has
 * erased it. Reading the catalogue writes nothing.
 */
export function holdsScopeTables(sql: SqlStorage): boolean {
  return (
    sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scope'`).toArray()
      .length > 0
  );
}

/**
 * Create the scope's tables, or bring those an older version created up to date, and then the
 * tables a host's history keeps beside them (`ScopeHistory.schema`).
 */
export function applySchema(sql: SqlStorage, history: readonly string[]): void {
  for (const statement of STATEMENTS) {
    sql.exec(statement);
  }
  for (const statement of history) {
    sql.exec(statement);
  }
}
