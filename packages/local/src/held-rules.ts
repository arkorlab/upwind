import {
  type DeploymentBundle,
  dynamicRouting,
  foldedHeaderRulesOf,
  headerRulesOf,
  spelledPrefixOf,
  staticFileLocalesOf,
} from '@stayingupwind/core/bundle';
import { KEY_SCHEMA_VERSION } from '@stayingupwind/core/cache';
import type { HeaderRule, ProjectManifest } from '@stayingupwind/core/manifest';
import { allowRecoveryScript } from '@stayingupwind/core/request';
import { compareCodeUnits } from '@stayingupwind/core/util';
import { nextSupportOf } from '@stayingupwind/host/next-support';
import { recoveryScriptCspSource } from '@stayingupwind/host/splice';

import { type CheckedStack, failed, type Verdict } from './answers.ts';
import { routedPathnames } from './held-routes.ts';

/**
 * The rules of the manifest the edge serves by, held to the build's (`checkStack`): the headers its
 * `next.config` sets, the redirects and rewrites the edge leaves to the Function, how it picks a
 * dynamic route's class and a page's Function, the spellings and locales a shipped file is found
 * by, the agents it serves no shell, its middleware's matchers, its images, and the scope its cache
 * entries are under — each as a deploy derives it from the build, not as the manifest under check
 * holds it. The check reads each from the manifest, to judge an answer by and to choose what to
 * ask: a rule dropped there would be dropped from what is asked and expected alike, and agreed with.
 */

/** Where a verdict is kept, by what was asked. */
interface Tallies {
  add(asked: string, verdict: Verdict): void;
}

/** A field of the manifest beside what a deploy derives of it from the build. */
interface Held {
  /** The field, as the manifest names it. */
  readonly name: string;
  readonly held: unknown;
  readonly built: unknown;
  /**
   * Whether the edge reads it in order — a later header rule's value over an earlier one's — or as
   * a set: whichever reserved rule matches a request claims it.
   */
  readonly ordered: boolean;
}

/**
 * A rule as a deploy lays it on a document the edge composes (`forDocuments` in the deploy): with
 * the policy it sets permitting the edge's recovery script, where it sets one that would not.
 */
function forDocuments(rule: HeaderRule, recovery: string): HeaderRule {
  const widened = allowRecoveryScript(rule.headers, recovery);
  const changed = Object.entries(rule.headers).some(([name, value]) => widened[name] !== value);
  return changed ? { ...rule, documentHeaders: widened } : rule;
}

/** `value` as JSON whose objects name their keys in one order, whatever order they were built in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) => {
    if (field === null || typeof field !== 'object' || Array.isArray(field)) {
      return field;
    }
    return Object.fromEntries(
      Object.entries(field).toSorted(([one], [other]) => compareCodeUnits(one, other)),
    );
  });
}

/** `value`'s elements, where it is a list; none where it is absent. */
function elementsOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Why a field held as a set is not the build's: the first element, in canonical order, held and
 * not derived, or derived and not held.
 */
function setFailure(field: Held): string | undefined {
  const held = elementsOf(field.held).map((element) => canonical(element));
  const built = elementsOf(field.built).map((element) => canonical(element));
  const invented = held.toSorted(compareCodeUnits).find((element) => !built.includes(element));
  if (invented !== undefined) {
    return `held by the manifest the edge serves by with the ${field.name} entry ${invented}, which the build has none of`;
  }
  const dropped = built.toSorted(compareCodeUnits).find((element) => !held.includes(element));
  return dropped === undefined
    ? undefined
    : `held by the manifest the edge serves by without the ${field.name} entry ${dropped} the build has`;
}

/** Why a field is not what a deploy derives of it from the build, in a verdict's words. */
function heldFailure(field: Held): string | undefined {
  if (!field.ordered) {
    return setFailure(field);
  }
  const held = canonical(field.held ?? null);
  const built = canonical(field.built ?? null);
  return held === built
    ? undefined
    : `held by the manifest the edge serves by with ${field.name} ${held}, not the ${built} a deploy derives from the build`;
}

/** A list the manifest keeps by its names (`exactPathnames`, `filesystemPages`), as the names. */
function namesOf(listed: Readonly<Record<string, true>> | undefined): string[] | undefined {
  return listed === undefined ? undefined : Object.keys(listed);
}

/**
 * The tables a deploy derives from the build's routing (`dynamicRouting`), for the pages it routes
 * (`routedPathnames`): the classes and their members, the rules reserved for the Function — a set,
 * as whichever matches claims a request — the pathnames resolved exactly, the pages of their own a
 * pattern also matches, the Functions they are in, and the spellings a slash makes.
 */
function routingFields(stack: CheckedStack): Held[] {
  const { manifest } = stack;
  const routing = dynamicRouting(stack.bundle, routedPathnames(stack));
  return [
    {
      name: 'dynamicRoutes',
      held: manifest.dynamicRoutes,
      built: routing.dynamicRoutes,
      ordered: true,
    },
    {
      name: 'reservedRoutes',
      held: manifest.reservedRoutes,
      built: routing.reservedRoutes,
      ordered: false,
    },
    {
      name: 'exactPathnames',
      held: namesOf(manifest.exactPathnames),
      built: routing.exactPathnames,
      ordered: false,
    },
    {
      name: 'filesystemPages',
      held: namesOf(manifest.filesystemPages),
      built: routing.filesystemPages,
      ordered: false,
    },
    {
      name: 'exactFunctions',
      held: manifest.exactFunctions,
      built: routing.exactFunctions,
      ordered: true,
    },
    {
      name: 'trailingSlash',
      held: manifest.trailingSlash,
      built: routing.trailingSlash,
      ordered: true,
    },
    {
      name: 'staticFileTrailingSlash',
      held: manifest.staticFileTrailingSlash,
      built: routing.staticFileTrailingSlash,
      ordered: true,
    },
  ];
}

/** The middleware's matchers as a deploy carries them: their patterns and conditions alone. */
function middlewareOf(bundle: DeploymentBundle): ProjectManifest['middleware'] {
  const matchers = bundle.middleware?.matchers.map((matcher) => {
    return {
      sourceRegex: matcher.sourceRegex,
      ...(matcher.has !== undefined && { has: matcher.has }),
      ...(matcher.missing !== undefined && { missing: matcher.missing }),
    };
  });
  return matchers === undefined ? undefined : { matchers };
}

/**
 * The header rules a deploy carries (`assembleManifest`): in their order, with what each lays on a
 * document; those folded into the routes of a build the edge does not route; and how a header's
 * `$` references are filled.
 */
async function headerFields(stack: CheckedStack): Promise<Held[]> {
  const { bundle, manifest } = stack;
  const recovery = await recoveryScriptCspSource();
  const headerRules = headerRulesOf(bundle).map((rule) => forDocuments(rule, recovery));
  return [
    {
      name: 'headerRules',
      held: manifest.headerRules,
      built: headerRules.length > 0 ? headerRules : undefined,
      ordered: true,
    },
    {
      name: 'foldedHeaderRules',
      held: manifest.foldedHeaderRules,
      built: foldedHeaderRulesOf(bundle)?.map((rule) => forDocuments(rule, recovery)),
      ordered: true,
    },
    {
      name: 'routerReferences',
      held: manifest.routerReferences,
      built: bundle.routerReferences,
      ordered: true,
    },
  ];
}

/**
 * The rest a deploy derives from the build: the default locales a file is found behind, what the
 * router reads of a path as written, the agents it sends blocking metadata to — its own list, and
 * whether Next.js streams a page to its crawlers (`nextSupportOf`) — the middleware's matchers, the
 * images it serves, and the scope its cache entries are under: the stack's deployment's, as the
 * stack deploys with a runtime cache.
 */
function buildFields(stack: CheckedStack): Held[] {
  const { bundle, manifest } = stack;
  return [
    {
      name: 'staticFileLocales',
      held: manifest.staticFileLocales,
      built: staticFileLocalesOf(bundle),
      ordered: true,
    },
    {
      name: 'spelledPrefix',
      held: manifest.spelledPrefix,
      built: spelledPrefixOf(bundle),
      ordered: true,
    },
    {
      name: 'htmlLimitedBots',
      held: manifest.htmlLimitedBots,
      built: bundle.config.htmlLimitedBots,
      ordered: true,
    },
    {
      name: 'crawlersStreamed',
      held: manifest.crawlersStreamed,
      built: nextSupportOf(bundle.nextVersion) === 'full' || undefined,
      ordered: true,
    },
    { name: 'middleware', held: manifest.middleware, built: middlewareOf(bundle), ordered: true },
    { name: 'images', held: manifest.images, built: bundle.config.images, ordered: true },
    {
      name: 'cache',
      held: manifest.cache,
      built: { keySchemaVersion: KEY_SCHEMA_VERSION, scopeId: stack.deploymentId },
      ordered: true,
    },
  ];
}

/**
 * Every rule of the manifest the edge serves by held to what a deploy derives of it from the build
 * (`assembleManifest`), field by field (`routingFields`, `headerFields`, `buildFields`).
 */
export async function misheldRules(stack: CheckedStack, tally: Tallies): Promise<void> {
  const fields = [...routingFields(stack), ...(await headerFields(stack)), ...buildFields(stack)];
  for (const field of fields) {
    const failure = heldFailure(field);
    if (failure !== undefined) {
      tally.add(field.name, failed(failure));
    }
  }
}
