import { readMeta } from './state.ts';

/** Written only by a verified new-scope activation, never by a visitor or a capability flag alone. */
export const GENERATION_PACK_SCHEMA_VERSION_META = 'generation_pack_schema_version';

/**
 * Only write/alarm paths ask this. Absence is permanently legacy for an already-created scope;
 * deploying new readers alone never upgrades its immutable Functions or changes its wire format.
 */
export function compactRepairLocatorsEnabled(sql: SqlStorage): boolean {
  return readMeta(sql, GENERATION_PACK_SCHEMA_VERSION_META) === '2';
}
