import type { HeaderRule } from './schema.ts';

/**
 * What tells the rules of a manifest ahead of the middleware from the others (`HeaderRule.phase`),
 * for the headers a request's rules set (`ConfiguredHeaders.aheadOfMiddleware`) to be gathered with
 * those of the rules ahead of the middleware apart, in the one judgement of them.
 */

/** What `next.config` sets on one request, and whether the request itself chose any of it. */
export interface ConfiguredHeaders {
  readonly headers: Record<string, string>;
  /**
   * A matched rule carried `has` or `missing`, so these headers are this visitor's.
   *
   * The same pathname answers differently to the next visitor, which is what makes the response
   * unshareable: a `Set-Cookie`, a CORS allowance or a disposition chosen for one request must not
   * be replayed to another out of a shared cache. Recorded here rather than asked for again,
   * because the judgement of the rules already knows it (`headerRulesFor`).
   */
  readonly conditioned: boolean;
  /**
   * What of these the rules ahead of the middleware set (`HeaderRule.phase`), judged on the same
   * request: what Next.js lays on whatever answers it, a Function it is handed on to included,
   * where a rule that runs on a match is judged on the request as it is finally matched, by what
   * answers it — the year-long `Cache-Control` of a build's own assets among them, which a request
   * the middleware moved off such a file does not take. Absent where a rule of the manifest says
   * no phase, as every one written before phases were did: nothing of those can be told ahead.
   */
  readonly aheadOfMiddleware?: ConfiguredHeaders | undefined;
}

/** One judgement of a request's header rules, retained for whichever answer is served. */
export interface RequestHeaderRules {
  readonly response: ConfiguredHeaders;
  readonly document: ConfiguredHeaders;
}

/** A manifest's rules where it carries none: of which, vacuously, every phase is known. */
export const NO_HEADER_RULES: readonly HeaderRule[] = [];
/** Whether each rule of a list says its phase, by the list, as `compiledRules` keeps its patterns. */
const phasedLists = new WeakMap<readonly HeaderRule[], boolean>();

/** Whether every rule of the list says the phase it came from (`HeaderRule.phase`). */
export function everyRulePhased(rules: readonly HeaderRule[]): boolean {
  let phased = phasedLists.get(rules);
  if (phased === undefined) {
    phased = rules.every((rule) => rule.phase !== undefined);
    phasedLists.set(rules, phased);
  }
  return phased;
}

/** A form of a request's configured headers as it is gathered, rule by matched rule. */
export interface Gathered {
  readonly headers: Record<string, string>;
  conditioned: boolean;
}

export function gathered(): Gathered {
  return { headers: {}, conditioned: false };
}

/** A form as it is handed on, with what the rules ahead of the middleware set of it, where known. */
export function configuredOf(all: Gathered, ahead: Gathered | undefined): ConfiguredHeaders {
  return {
    headers: all.headers,
    conditioned: all.conditioned,
    ...(ahead !== undefined && {
      aheadOfMiddleware: { headers: ahead.headers, conditioned: ahead.conditioned },
    }),
  };
}
