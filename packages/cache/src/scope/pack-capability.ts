import { createRepairStorageNamespace } from '@stayingupwind/core/cache';
import { type SeedScopeInput, scopePackReadersSchema } from '@stayingupwind/host/cache';

import { readScope, writeMeta } from './state.ts';

const READER_PROOF_META = 'generation_pack_reader_proof';

/** Only write/alarm paths ask this; healthy reads hydrate from their existing scope-row read. */
export function compactRepairLocatorsEnabled(sql: SqlStorage): boolean {
  return readScope(sql)?.pack_schema_version === 2;
}

/**
 * A verified approval is bound to one newly-created immutable deployment and build. A legacy or
 * mismatched request remains version one; no old Function is made to fall back on a newer record.
 */
export function firstPackSchemaVersion(seed: SeedScopeInput): 1 | 2 {
  // The seed already accepts plain host metadata. Use its existing string slot so this new
  // protocol does not reject any older host's seed or change its catchall acceptance policy.
  const encoded = seed['generationPackReaders'];
  if (typeof encoded !== 'string') return 1;
  try {
    const parsed = scopePackReadersSchema.safeParse(JSON.parse(encoded));
    if (!parsed.success) return 1;
    const proof = parsed.data;
    const names = new Set(proof.consumers.map((consumer) => consumer.name));
    return names.size === proof.consumers.length &&
      proof.deploymentId === seed.scope.scopeId &&
      proof.deploymentId === seed.scope.deploymentId &&
      proof.buildId === seed.scope.buildId
      ? 2
      : 1;
  } catch {
    return 1;
  }
}

/** Only a first seed with no scope row calls this; existing scopes are never promoted in place. */
export function prepareFirstPackSchema(
  sql: SqlStorage,
  seed: SeedScopeInput,
): {
  readonly packSchemaVersion: 1 | 2;
  readonly repairNamespace: string | null;
} {
  // Old failed first seeds can leave an empty legacy table. Migrate it on this write, not in the
  // constructor or an ordinary read. Tables created by this version already have the column.
  const columns = new Set(
    [...sql.exec<{ name: string }>('PRAGMA table_info(scope)')].map((column) => column.name),
  );
  if (!columns.has('pack_schema_version')) {
    sql.exec('ALTER TABLE scope ADD COLUMN pack_schema_version INTEGER NOT NULL DEFAULT 1');
  }
  if (!columns.has('repair_namespace'))
    sql.exec('ALTER TABLE scope ADD COLUMN repair_namespace TEXT');
  const version = firstPackSchemaVersion(seed);
  if (version === 2) writeMeta(sql, READER_PROOF_META, String(seed['generationPackReaders']));
  return {
    packSchemaVersion: version,
    repairNamespace: version === 2 ? createRepairStorageNamespace() : null,
  };
}
