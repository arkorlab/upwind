import { keyedParameters } from '../manifest/completion.ts';
import type { MemberRoute } from '../manifest/schema.ts';
import { writtenFromList } from '../request/blocking-metadata.ts';
import { queryDependent } from './query.ts';
import type { DeploymentBundle, Prerender } from './schema.ts';
import { standsForClass } from './spelling.ts';

/**
 * What serves a member of a class the build made no shell of from the record its first render
 * leaves, by the template a dynamic route resolves to (`MemberRoute`), where its members leave one:
 * a page that renders its unknown members blocking — the build wrote the class with no body, as
 * App Router and a Pages Router `fallback: 'blocking'` do — on the Node.js runtime, whose members are
 * keyed by a pathname alone (`queryDependent`) — their own, or the shell they complete to
 * (`keyedBy`) — and whose class the edge could serve as a shell (`servableIn`): no rule claims it
 * ahead of the filesystem, and no header rule the edge cannot judge covers it.
 *
 * Not a Pages Router `fallback: true` class. Its body is the loading page the build wrote, which a
 * runtime cache keys the class by and holds no generation of (`generationIn`): the deployment's
 * Function renders each member whole, and keeps none.
 */

const HTTP_OK = 200;

/** What the edge asks of a page before it serves one, said of the bundle (`servableIn`). */
export interface ServedPages {
  /** The routes on Next.js's edge runtime, whose renders nothing captures. */
  readonly edgeRuntime: ReadonlySet<string>;
  /** Whether a prerender is a page's document rather than a response or one beside a document. */
  readonly isDocument: (prerender: Prerender) => boolean;
  /** Whether no rule of `next.config` keeps the page from the edge. */
  readonly servable: (prerender: Prerender) => boolean;
}

/** Whether the edge serves the members of a page's class from their records, by its template. */
function servesMembers(prerender: Prerender, pages: ServedPages): boolean {
  return (
    prerender.body === undefined &&
    !pages.edgeRuntime.has(prerender.route) &&
    (prerender.initialStatus === undefined || prerender.initialStatus === HTTP_OK) &&
    // Of any member: its pathname names every parameter of the route, and nothing else.
    !queryDependent(prerender, prerender.route, '/') &&
    pages.servable(prerender)
  );
}

export function memberRoutesOf(
  bundle: DeploymentBundle,
  pages: ServedPages,
): (template: string) => MemberRoute | undefined {
  const kinds = new Map(bundle.entrypoints.map((entry) => [entry.pathname, entry.kind]));
  // The class itself, not a member whose value is spelled as its own placeholder, which shares the
  // template's pathname (`standsForClass`).
  const templates = new Map(
    bundle.prerenders
      .filter((prerender) => standsForClass(prerender) && pages.isDocument(prerender))
      .map((prerender) => [prerender.pathname, prerender]),
  );
  return (template) => {
    const prerender = templates.get(template);
    const kind = prerender === undefined ? undefined : kinds.get(prerender.route);
    if (
      prerender === undefined ||
      (kind !== 'app-page' && kind !== 'pages') ||
      !servesMembers(prerender, pages)
    ) {
      return;
    }
    // Not the condition `next build` writes from the list of crawlers it renders a page whole for
    // (`writtenFromList`), which is most of what every class carries: a visitor it holds for is
    // passed on before any member is looked up, as for every pathname that names no route
    // (`blockingMetadataReason`).
    const bypassFor = prerender.bypassFor?.filter(
      (condition) => !writtenFromList(condition, bundle.config.htmlLimitedBots),
    );
    // Kept under the shell its members complete to where the build keys them by some of the
    // route's parameters (`completedShell`, in the runtime), which the record is read by.
    const keyedBy = keyedParameters(prerender.route, prerender.allowQuery);
    return {
      route: prerender.route,
      kind,
      ...(bypassFor !== undefined && bypassFor.length > 0 && { bypassFor }),
      ...(keyedBy !== undefined && { keyedBy }),
    };
  };
}
