import type { Prerender } from '@stayingupwind/core/bundle';

import { collectPrerenders, type PrerenderCollection, type ShippedBlob } from './collect.ts';
import { auditFunctionSize, type FunctionUpload, overLimit } from './dependencies.ts';
import { checkPageBodyRange } from './page-bodies.ts';

/**
 * Which prerendered bodies a build's app Functions carry, as the host's `unshippedPrerenderBodies`
 * says: every one, without it; every one but those in its range, by default (`when: 'always'`); or
 * every one unless that takes an app Function past the size limit, and then every one but those in
 * its range (`when: 'over-limit'`).
 *
 * The last is a build laid out twice at most, from the one `next build`. First as if the host had
 * not set the option, which is what a build within the limit then is, byte for byte: the same
 * bundle, the same modules, the same runtime, and no page body left to the host's reader for a
 * request to wait on. Only when a Function of that layout is past the limit are they laid out
 * again, with the range applied as `'always'` would apply it, and what that layout weighs is
 * audited as any build's is: a build still past the limit fails as it would have without the
 * option.
 */

const KIB = 1024;
const MIB = KIB * KIB;

function mib(bytes: number): string {
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

/** What the app Functions carry of the prerendered bodies, and whether a body may be missing. */
export interface PageBodyLayout {
  readonly shipped: readonly ShippedBlob[];
  /**
   * Whether a body the Functions do not carry is read through the host's `createBundleBlobReader`,
   * which the runtime is then built to link (`generatedModulesPlugin`).
   */
  readonly requireBundleBlobReader?: boolean | undefined;
}

/** The layout a build starts from, and what it falls back to past the limit, where it may. */
export interface PageBodyLayouts extends PageBodyLayout {
  /**
   * What the app Functions carry with the host's range applied, for a range left to the limit
   * (`when: 'over-limit'`): collected only once a layout is past it, which most builds never are.
   */
  readonly shippedOverLimit?: (() => Promise<readonly ShippedBlob[]>) | undefined;
  /**
   * The files every app Function carries however its bodies are laid out, which it answers itself
   * (`travelsWithFunction`): a body with the same bytes as one of them is left out of none.
   */
  readonly staticBlobs?: readonly { readonly sha256: string }[] | undefined;
}

/**
 * The bodies a layout past the limit left out of the app Functions of a route it shipped them for,
 * each blob once: whether it shipped them for no route then, or still for another.
 */
export interface BodiesLeftOut {
  readonly count: number;
  readonly bytes: number;
}

/**
 * The build's prerenders, and the layout its app Functions start from.
 *
 * `collectPrerenders` applies whatever range it is handed; which builds a range applies to is decided
 * here. A range left to the limit is handed to it only by the fallback, which collects the same
 * outputs again — the same records, the same blobs, with the bodies in the range no longer shipped —
 * rather than every build holding a second layout that only a build past the limit would use.
 */
export async function collectPageBodies(
  collection: PrerenderCollection,
): Promise<PageBodyLayouts & { readonly prerenders: Prerender[] }> {
  const range = collection.unshippedBodies;
  checkPageBodyRange(range);
  const pastTheLimitOnly = range?.when === 'over-limit';
  const { prerenders, shipped } = await collectPrerenders(
    pastTheLimitOnly ? { ...collection, unshippedBodies: undefined } : collection,
  );
  return {
    prerenders,
    shipped,
    requireBundleBlobReader: range !== undefined && !pastTheLimitOnly,
    shippedOverLimit: pastTheLimitOnly
      ? async () => (await collectPrerenders(collection)).shipped
      : undefined,
  };
}

/** The app Functions of one layout, as `withinTheLimit` weighs them. */
interface LaidOut {
  readonly built: readonly {
    readonly name: string;
    readonly built: {
      readonly spec:
        | { readonly modules: FunctionUpload['modules']; readonly runtime?: undefined }
        | { readonly runtime: 'node-container' };
      readonly dependencies: { readonly size: FunctionUpload['size'] };
    };
  }[];
  readonly bodiesLeftOut?: BodiesLeftOut | undefined;
}

/** The first Function of a layout past the limit, in the order they were built: the audit's order. */
function firstOverLimit(
  laidOut: LaidOut,
): { readonly name: string; readonly upload: FunctionUpload; readonly over: string } | undefined {
  for (const { name, built } of laidOut.built) {
    // The archive has its own Node artifact limit; Worker module limits cannot weigh it.
    if (built.spec.runtime === 'node-container') continue;
    const over = overLimit(built.dependencies.size);
    if (over !== undefined) {
      return { name, upload: { modules: built.spec.modules, size: built.dependencies.size }, over };
    }
  }
  return undefined;
}

/**
 * What one layout carries that another leaves out for a route, each blob once. A blob is read by the
 * Functions holding a route that names it (`carriesBlob`), and two routes can name the same bytes,
 * of which the range may leave out one and not the other: the blob is still shipped, and a Function
 * of a split build that holds only the route left out carries it no more. So too where the first
 * layout was one Function: its plan may have set aside a budget no Function could meet, the
 * smallest of its routes past it (`planFunctions`), and split the routes once the body is left out.
 * Where one Function still holds both routes, the second layout weighs the same, and its audit
 * refuses it, one layout later. Not a body with the bytes of a file every Function carries anyway
 * (`everywhere`), which no layout leaves out of any.
 */
function leftOut(
  carried: readonly ShippedBlob[],
  kept: readonly ShippedBlob[],
  everywhere: ReadonlySet<string>,
): BodiesLeftOut {
  const still = new Map(kept.map((blob) => [blob.sha256, new Set(blob.routes)]));
  const left = carried.filter((blob) => {
    if (everywhere.has(blob.sha256)) {
      return false;
    }
    const routes = still.get(blob.sha256);
    return routes === undefined || blob.routes.some((route) => !routes.has(route));
  });
  return {
    count: left.length,
    bytes: left.reduce((total, blob) => total + blob.bytes.byteLength, 0),
  };
}

/**
 * The app Functions `layOut` makes of the layout a build starts from — or, where the host left its
 * range to the limit and a Function of that layout is past it, of the range applied.
 *
 * `weighOnly` has `layOut` leave every Function's size to this function rather than refuse the
 * first past the limit, since that Function is what decides whether to lay them out again. The
 * layout made then is not weighed here: it is what the build uploads, and `layOut` holds it to the
 * limit as it would any build's, so a build the range does not bring under it fails as it always
 * has, with the audit's own message about the Function it made.
 */
export async function withinTheLimit<T extends LaidOut>(
  layouts: PageBodyLayouts,
  layOut: (layout: PageBodyLayout, weighOnly: boolean) => Promise<T>,
): Promise<T> {
  const fallback = layouts.shippedOverLimit;
  if (fallback === undefined) {
    return layOut(layouts, false);
  }
  const first = await layOut(layouts, true);
  const past = firstOverLimit(first);
  if (past === undefined) {
    return first;
  }
  const shipped = await fallback();
  const everywhere = new Set(layouts.staticBlobs?.map((blob) => blob.sha256));
  const left = leftOut(layouts.shipped, shipped, everywhere);
  if (left.count === 0) {
    // Nothing in it is a body the host could serve instead, for any route, so a second layout would
    // weigh the same: the Function is refused now, by the audit the first layout left to this
    // function.
    auditFunctionSize(past.name, past.upload);
  }
  const bodies = left.count === 1 ? 'body' : 'bodies';
  console.log(
    `@stayingupwind/adapter: with every page body in it, the ${past.name} server bundle is ${past.over}. Building the app Functions again with ${String(left.count)} completed page ${bodies} (${mib(left.bytes)}) left in bundle storage, as unshippedPrerenderBodies allows past the limit (when: 'over-limit'): a Function that answers one of those pages itself reads its body through the host's createBundleBlobReader.`,
  );
  return {
    ...(await layOut({ shipped, requireBundleBlobReader: true }, false)),
    bodiesLeftOut: left,
  };
}
