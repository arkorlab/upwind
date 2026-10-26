import { BuildPatternBudget, type BuildPatternMatcher } from './pattern-budget.ts';
import type { Route, StaticFile } from './schema.ts';
import { reproducesDynamicRouting, type ServingBundle } from './serving.ts';
import { routerSpellings } from './spelling.ts';
import { travelsWithFunction } from './static-files.ts';

function isConditional(rule: Route): boolean {
  return rule.has !== undefined || rule.missing !== undefined;
}

/**
 * A path with nothing in it for a router to interpret: no parameter, no group, no wildcard. Only
 * such a source and destination say, at build time, exactly which request a rule answers and with
 * what — which is what `edgeServedRewrites` needs before it may answer one itself.
 */
const LITERAL_PATHNAME = /^\/[^\s:(*?#[]*$/u;
export interface ServedRewrite {
  /** The rule this came from, so the routing it is taken out of can leave it out. */
  readonly rule: Route;
  /** What the visitor asks for. */
  readonly pathname: string;
  readonly file: StaticFile;
}

/** A rule that can change where this pathname goes, for at least one request. */
function mayRoutePath(rule: Route, pathname: string, patterns: BuildPatternMatcher): boolean {
  if (rule.destination === undefined && rule.status === undefined) {
    return false;
  }
  // Conditions cannot be settled at build time: an alias must be right for every request. Match
  // the compiled pattern, including parameterized sources and Next.js's case-insensitive default.
  return patterns.test(rule.sourceRegex, 'i', pathname);
}

/** The literal file a rule can name, before routing precedence is considered. */
function rewriteCandidate(
  rule: Route,
  files: ReadonlyMap<string, StaticFile>,
  basePath: string,
): ServedRewrite | undefined {
  const { source, destination } = rule;
  if (
    source === undefined ||
    destination === undefined ||
    rule.status !== undefined ||
    isConditional(rule) ||
    !LITERAL_PATHNAME.test(source) ||
    !LITERAL_PATHNAME.test(destination)
  ) {
    return undefined;
  }
  const file = files.get(destination);
  return file === undefined || travelsWithFunction(file, basePath)
    ? undefined
    : { rule, pathname: source, file };
}

/**
 * The rewrites the edge serves from its own storage rather than handing to the Function.
 *
 * A rewrite to a file too large to travel with the Function had nowhere to be answered: the Function
 * is where routing happens, and the file it resolves to is not in the manifest compiled into it,
 * so the request came back a miss while the edge held the bytes all along. Resolved here, once,
 * against the build — never at request time — and the edge serves the source pathname as the
 * static file it names.
 *
 * Only a rule that says at build time exactly what it answers qualifies: a literal source and
 * destination, no condition, no status, and no earlier rule that may claim its source. A
 * `beforeFiles` rewrite overrides an existing pathname, but must leave its destination alone for
 * the rest of that phase; an `afterFiles` rewrite is reached only when no file or exact route
 * claims its source. Conditions and rewrite chains stay with the router that can resolve them.
 */
export function edgeServedRewrites(
  bundle: ServingBundle,
  patterns: BuildPatternMatcher = new BuildPatternBudget(),
): ServedRewrite[] {
  if (!reproducesDynamicRouting(bundle)) {
    return [];
  }
  const { basePath } = bundle.config;
  const files = new Map(bundle.staticFiles.map((file) => [file.pathname, file]));
  // A page or a file is found under every spelling the router finds it by (`routerSpellings`):
  // `/about/` is the page `/about`, and `/manual/` the file `/manual`, ahead of `afterFiles`.
  const named = [...bundle.entrypoints, ...bundle.prerenders].map((output) => output.pathname);
  const claimed = new Set(
    [...files.keys(), ...named].flatMap((pathname) => routerSpellings(bundle, pathname)),
  );
  const served: ServedRewrite[] = [];
  // Every earlier rule counts, including one serving a small file, a conditional rule and a
  // redirect before middleware. Failing to promote one does not mean routing skipped it.
  const earlier = [...bundle.routing.beforeMiddleware];
  const phases = [
    { rules: bundle.routing.beforeFiles, beforeFiles: true },
    { rules: bundle.routing.afterFiles, beforeFiles: false },
  ];
  for (const phase of phases) {
    for (const [index, rule] of phase.rules.entries()) {
      const candidate = rewriteCandidate(rule, files, basePath);
      const prior =
        candidate !== undefined &&
        earlier.some((route) => mayRoutePath(route, candidate.pathname, patterns));
      earlier.push(rule);
      if (
        candidate === undefined ||
        prior ||
        (!phase.beforeFiles && claimed.has(candidate.pathname))
      ) {
        continue;
      }
      // Unlike afterFiles, beforeFiles keeps rewriting before checking the filesystem. A later
      // rule can replace this destination, even though the build already contains a file there.
      if (
        phase.beforeFiles &&
        phase.rules
          .slice(index + 1)
          .some((route) => mayRoutePath(route, candidate.file.pathname, patterns))
      ) {
        continue;
      }
      served.push(candidate);
    }
  }
  return served;
}
