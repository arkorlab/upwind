/** Reading the edge's own `x-arkor-edge` debug header, for whoever measures what it served. */

/** What the edge says about the response it produced. */
export interface EdgeResponseMarkers {
  /** The `x-arkor-edge` header, or `''` when there was none. */
  readonly debug: string;
  /** Whether `x-arkor-edge-validated` was set, which only an accepted validation header produces. */
  readonly validated: boolean;
}

/** The manifest and policy a validation header asked the edge to answer under. */
export interface CandidateTarget {
  readonly manifestId: string;
  readonly policyId: string;
}

/** How much of the manifest id `x-arkor-edge` names, so a reader can tell which one answered. */
export const MANIFEST_ID_PREFIX_LENGTH = 8;

export function manifestIdPrefix(manifestId: string): string {
  return manifestId.slice(0, MANIFEST_ID_PREFIX_LENGTH);
}

/**
 * Whether an edge response was produced by the policy being validated.
 *
 * The debug header is a `;`-separated list, so the field is compared whole: a substring test would
 * accept `policy=v1-beta` for a run validating `v1`.
 */
export function respondedUnderPolicy(debug: string, policyId: string): boolean {
  return debug.split(';').includes(`policy=${policyId}`);
}

/**
 * Whether the candidate a validation header asked for is what answered.
 *
 * The policy id alone does not settle it. A validation header the edge cannot verify — a stale or
 * wrong HMAC key is all it takes — is ignored in silence and the project's active pointer answers
 * instead; when the candidate reuses the active policy, as benchmarking a new manifest does, that
 * answer carries the very id being checked for. `x-arkor-edge-validated` is what only an accepted
 * header produces, and the manifest prefix names which manifest it was served from.
 */
export function answeredAsCandidate(
  markers: EdgeResponseMarkers,
  candidate: CandidateTarget,
): boolean {
  if (!markers.validated) {
    return false;
  }
  const fields = markers.debug.split(';');
  return (
    fields.includes(`m=${manifestIdPrefix(candidate.manifestId)}`) &&
    respondedUnderPolicy(markers.debug, candidate.policyId)
  );
}
