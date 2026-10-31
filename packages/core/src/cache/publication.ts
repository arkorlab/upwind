import { sha256HexOfText } from '../artifact/hash.ts';
import { SNAPSHOT_PUBLICATION_VERSION } from './publication-version.ts';
import { resourceSnapshotOf } from './resource-snapshot.ts';

/** A trusted publisher's absolute admission deadline, independent of cache freshness. */
export interface PublicationGrant {
  readonly scope: string;
  readonly dataGeneration: string;
  readonly publicationEpoch: number;
  readonly release: { readonly id: string; readonly digest: string };
  readonly validUntil: number;
}

/** Required readers must understand this capability before publishing its manifest. */
interface PublicationSources {
  readonly identities: readonly string[];
  /** Source route identities whose cacheable responses require a grant. */
  readonly routes: readonly string[];
  /** Host proof that these routes' shipped shells contain no protected data. */
  readonly independentBuild?: readonly string[] | undefined;
}

export type PublicationRequirement = PublicationSources &
  (
    | { readonly version: 1 }
    | {
        readonly version: 2;
        /** Every protected value is observed before use, including nested streamed/cached reads. */
        readonly valueObservers: true;
      }
    | {
        readonly version: typeof SNAPSHOT_PUBLICATION_VERSION;
        readonly valueObservers: true;
        /** Cache publications validate the producer's original resource versions. */
        readonly resourceSnapshots: true;
      }
  );

const PREFIX = 'upwind:publication:v1:';
const IDENTITY = /^[a-f0-9]{64}$/u;
const GRANT = /^upwind:publication:v1:([a-f0-9]{64}):([1-9]\d{0,15})$/u;
const clocks = new WeakMap<WeakKey, { latest: number; valid: boolean }>();
const requirements = new WeakMap<
  PublicationRequirement,
  {
    identities: ReadonlySet<string>;
    routes: ReadonlySet<string>;
    independent: ReadonlySet<string>;
  }
>();

function indexOf(required: PublicationRequirement) {
  const held = requirements.get(required);
  if (held !== undefined) return held;
  const index = {
    identities: new Set(required.identities),
    routes: new Set(required.routes),
    independent: new Set(required.independentBuild),
  };
  requirements.set(required, index);
  return index;
}

/** A detected rollback permanently closes this runtime's protected cache admission. */
export function publicationTimeFor(owner: WeakKey, now: number): number {
  const clock = clocks.get(owner) ?? { latest: now, valid: Number.isFinite(now) };
  if (!Number.isFinite(now) || now < clock.latest) clock.valid = false;
  clock.latest = Math.max(clock.latest, now);
  clocks.set(owner, clock);
  return clock.valid ? now : NaN;
}

/** The deadline is deliberately excluded: a later grant is the same publication identity. */
export async function publicationIdentity(grant: PublicationGrant): Promise<string> {
  if (
    !grant.scope ||
    !grant.dataGeneration ||
    !grant.release.id ||
    !IDENTITY.test(grant.release.digest) ||
    !Number.isSafeInteger(grant.publicationEpoch) ||
    grant.publicationEpoch < 0 ||
    !Number.isSafeInteger(grant.validUntil) ||
    grant.validUntil <= 0
  )
    throw new TypeError('Invalid publication grant.');
  return sha256HexOfText(
    JSON.stringify([
      grant.scope,
      grant.dataGeneration,
      grant.publicationEpoch,
      grant.release.id,
      grant.release.digest,
    ]),
  );
}

/** Tags travel with Next's nested dependencies, stored data, artifacts and delivery packs. */
export async function publicationTagOf(grant: PublicationGrant): Promise<string> {
  return `${PREFIX}${await publicationIdentity(grant)}:${String(grant.validUntil)}`;
}

export function isPublicationTag(tag: string): boolean {
  return tag.startsWith('upwind:publication:');
}

function snapshotMissing(tags: readonly string[], required?: PublicationRequirement): boolean {
  if (required?.version !== SNAPSHOT_PUBLICATION_VERSION) return false;
  try {
    // Check all tags: one valid witness cannot conceal another malformed reserved tag.
    return tags.map((tag) => resourceSnapshotOf(tag)).every((witness) => witness === undefined);
  } catch {
    return true;
  }
}

/** An invalid bound is already expired. Combining dependencies can only shorten a bound. */
export function publicationDeadline(
  tags: readonly string[],
  required?: PublicationRequirement,
): number | undefined {
  if (snapshotMissing(tags, required)) return 0;
  let deadline: number | undefined;
  const found = new Set<string>();
  for (const tag of tags) {
    if (!isPublicationTag(tag)) continue;
    const match = GRANT.exec(tag);
    const identity = match?.[1];
    const until = Number(match?.[2]);
    if (
      identity === undefined ||
      !Number.isSafeInteger(until) ||
      (required !== undefined && !indexOf(required).identities.has(identity))
    )
      return 0;
    found.add(identity);
    deadline = Math.min(deadline ?? until, until);
  }
  if (required?.identities.some((identity) => !found.has(identity)) === true) return 0;
  return deadline;
}

export function publicationForRoute(
  required: PublicationRequirement | undefined,
  route: string,
): PublicationRequirement | undefined {
  return required !== undefined && indexOf(required).routes.has(route) ? required : undefined;
}

export function publicationForBuild(
  required: PublicationRequirement | undefined,
  route: string,
): PublicationRequirement | undefined {
  return required !== undefined && indexOf(required).independent.has(route)
    ? undefined
    : publicationForRoute(required, route);
}

export function publicationExpired(
  tags: readonly string[],
  now: number,
  required?: PublicationRequirement,
): boolean {
  const until = publicationDeadline(tags, required);
  return until !== undefined && (!Number.isFinite(now) || now >= until);
}
