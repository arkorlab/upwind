import type { BuildProjectManifestInput } from './manifest.ts';
import {
  MANIFEST_SCHEMA_VERSION,
  PUBLICATION_MANIFEST_SCHEMA_VERSION,
  PAGES_FALLBACK_SCHEMA_VERSION,
  REQUEST_FILE_KEYS_SCHEMA_VERSION,
  type ProjectManifest,
} from './schema.ts';
const PAGES_FALLBACK_PRIVACY = 3;
export function schemaVersionFor(
  input: BuildProjectManifestInput,
): ProjectManifest['schemaVersion'] {
  if (input.publication !== undefined) return PUBLICATION_MANIFEST_SCHEMA_VERSION;
  if (
    (input.pagesFallbacks?.length ?? 0) > 0 ||
    input.staticPages?.some((page) => page.staticPagePrivacy === PAGES_FALLBACK_PRIVACY) === true
  )
    return PAGES_FALLBACK_SCHEMA_VERSION;
  return input.staticFileRequestKeys === true
    ? REQUEST_FILE_KEYS_SCHEMA_VERSION
    : MANIFEST_SCHEMA_VERSION;
}
