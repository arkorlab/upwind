import { decodeGenerationPack, type PackArtifactRef } from '@stayingupwind/core/cache';
import { allowRecoveryScript } from '@stayingupwind/core/request';
import { RECOVERY_SCRIPT_CSP_SOURCE } from '@stayingupwind/host/splice';

import type { RecordedGeneration, RecordedOutput } from './protocol.ts';

/** An output's public identity and bytes, without its storage location. */
function outputOf(artifact: PackArtifactRef): RecordedOutput {
  const { role, representationKey, encoding, sha256, byteLength } = artifact;
  return { role, representationKey, encoding, sha256, byteLength };
}

/**
 * Metadata observed through KV or authority, retained while the local Worker can serve its records.
 * A separate entry-count eviction cannot track the edge's byte-budgeted cache. Keep metadata, not
 * pack/body buffers; a long-running local stack therefore retains more metadata as it sees records.
 */
export function rememberGeneration(
  generations: Map<string, RecordedGeneration>,
  key: string,
  value: unknown,
): void {
  if (!(value instanceof ArrayBuffer)) return;
  const decoded = decodeGenerationPack(new Uint8Array(value));
  if (decoded.kind !== 'ok') return;
  const { seq, headers, artifacts, postponedSha256, source } = decoded.pack.header;
  const { policy, cacheTimestamp, invalidation } = decoded.pack.header;
  // Match generation-loader's recovery permission before nonce stamping or configured overlays.
  const permitted =
    headers['content-security-policy'] === undefined || decoded.pack.postponed === undefined
      ? headers
      : allowRecoveryScript(headers, RECOVERY_SCRIPT_CSP_SOURCE);
  const at = `${key}|${seq}`;
  generations.delete(at);
  generations.set(at, {
    headers: permitted,
    artifacts: artifacts.map((artifact) => outputOf(artifact)),
    partial: postponedSha256 !== null,
    source,
    freshness: { policy, cacheTimestamp, invalidation },
  });
}
