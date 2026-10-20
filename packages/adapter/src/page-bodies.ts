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
}

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
}

/** Omitted page bodies require a host reader, unlike the default that ships every body. */
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
