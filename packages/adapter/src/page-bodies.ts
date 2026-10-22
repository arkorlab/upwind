import {
  completeAppPageBody,
  type Entrypoint,
  primaryPrerenders,
  type Prerender,
} from '@stayingupwind/core/bundle';

/** Inclusive sizes of completed page bodies the host elects to keep outside the Function. */
export interface UnshippedPrerenderBodies {
  readonly minBytes: number;
  readonly maxBytes: number;
  /**
   * Which builds the range applies to. `'always'`, the default, leaves those bodies out of every
   * build. `'over-limit'` leaves them out only of a build whose app Functions would otherwise be past
   * the size limit (`MAX_FUNCTION_BYTES`): the build lays the Functions out with every body in them,
   * exactly as it would without the option, and lays them out again with the range applied only
   * when one of them is past the limit (`withinTheLimit`).
   */
  readonly when?: 'always' | 'over-limit' | undefined;
}

/**
 * What `when` may say. Asked of the value rather than trusted to the type, because configuration
 * need not be typed, and a misspelt `'over-limit'` read as the default would leave bodies out of
 * every build — the one outcome a host that asked for it set out to avoid.
 */
const WHEN: ReadonlySet<unknown> = new Set(['always', 'over-limit', undefined]);

export function checkPageBodyRange(range: UnshippedPrerenderBodies | undefined): void {
  if (
    range !== undefined &&
    (!Number.isSafeInteger(range.minBytes) ||
      !Number.isSafeInteger(range.maxBytes) ||
      range.minBytes < 1 ||
      range.maxBytes < range.minBytes)
  ) {
    throw new Error(
      '@stayingupwind/adapter: unshippedPrerenderBodies requires positive integer minBytes <= maxBytes',
    );
  }
  if (range !== undefined && !WHEN.has(range.when)) {
    throw new Error(
      `@stayingupwind/adapter: unshippedPrerenderBodies.when must be 'always' or 'over-limit', got ${JSON.stringify(range.when)}`,
    );
  }
}

/**
 * Omitted page bodies require a host reader, unlike the default that ships every body. So does a
 * range left to the limit (`when: 'over-limit'`): which builds it leaves bodies out of is decided
 * only once a build has weighed its Functions, long after a host could still name a reader.
 */
export function checkPageBodyHost(
  range: UnshippedPrerenderBodies | undefined,
  hostModule: string | undefined,
): void {
  checkPageBodyRange(range);
  if (range !== undefined && (typeof hostModule !== 'string' || hostModule.trim().length === 0)) {
    throw new Error(
      '@stayingupwind/adapter: unshippedPrerenderBodies requires a nonempty cacheHostModule exporting createBundleBlobReader',
    );
  }
}

/** Decide from the untouched build records, before collection turns postponed state into blobs. */
export function pageBodyOmission(input: {
  readonly sources: readonly { readonly prerender: Prerender; readonly hasPostponed: boolean }[];
  readonly entrypoints: readonly Entrypoint[];
  readonly nodeAppPageIds: ReadonlySet<string>;
  readonly range: UnshippedPrerenderBodies | undefined;
  readonly basePath: string;
  readonly rscSuffix: string;
}): (prerender: Prerender, byteLength: number) => boolean {
  const { range } = input;
  checkPageBodyRange(range);
  if (range === undefined) return () => false;
  const documents = primaryPrerenders(input.sources.map((source) => source.prerender));
  const postponed = new Set(
    input.sources.filter((source) => source.hasPostponed).map((source) => source.prerender.id),
  );
  const entries = new Map(input.entrypoints.map((entry) => [entry.pathname, entry]));
  const eligible = new Set(
    input.sources.flatMap(({ prerender }) => {
      const document = documents.get(prerender.id);
      return !input.nodeAppPageIds.has(prerender.parentOutputId) ||
        postponed.has(prerender.id) ||
        (document !== undefined && postponed.has(document.id)) ||
        !completeAppPageBody({
          prerender,
          document,
          entry: entries.get(prerender.route),
          basePath: input.basePath,
          rscSuffix: input.rscSuffix,
        })
        ? []
        : [prerender.id];
    }),
  );
  return (prerender, byteLength) =>
    eligible.has(prerender.id) && byteLength >= range.minBytes && byteLength <= range.maxBytes;
}
