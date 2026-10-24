import { runInNewContext } from 'node:vm';

import { resolveRoutes, type Route } from '@next/routing';
import { buildProjectManifest, headerRulesFor } from '@stayingupwind/core/manifest';
import { describe, expect, it } from 'vitest';

/**
 * A bundle the adapter writes says its Functions fill a header's `$` references in one pass
 * (`routerReferences`), and the edge fills that deployment's headers the same way. What makes it
 * true is the router the runtime is built on, which is the one installed here: these hold the
 * edge's filling to that router's, so a router that fills them otherwise fails here rather than
 * leaving the edge and the Function to answer one request two ways.
 */

interface Example {
  readonly rule: Route;
  readonly pathname: string;
}

const TEN_CAPTURES = String.raw`^\/x\/([^\/]+?)\/([^\/]+?)\/([^\/]+?)\/([^\/]+?)\/([^\/]+?)\/([^\/]+?)\/([^\/]+?)\/([^\/]+?)\/([^\/]+?)\/([^\/]+?)$`;

const examples: Example[] = [
  {
    rule: {
      sourceRegex: String.raw`^\/docs(?:\/([^\/]+?))$`,
      headers: { 'x-prefix': '$10', 'x-zero': '$01', 'x-first': '$1', 'x-after': '$1x' },
    },
    pathname: '/docs/intro',
  },
  {
    rule: {
      sourceRegex: TEN_CAPTURES,
      headers: { 'x-tenth': '$10', 'x-pair': '$1-$2', 'x-inserted': '$3' },
    },
    pathname: '/x/a/b/$1/d/e/f/g/h/i/j',
  },
  {
    rule: {
      sourceRegex: String.raw`^\/team\/(?<nxtPteam>[^\/]+?)\/(?<nxtPteamId>[^\/]+?)$`,
      headers: { 'x-team': '$nxtPteam:$nxtPteamId' },
    },
    pathname: '/team/core/42',
  },
];

/** The headers the installed router gives `pathname` for the rule, as a deployment's Function does. */
async function routerHeaders({ rule, pathname }: Example): Promise<Record<string, string>> {
  const result = await resolveRoutes({
    url: new URL(`https://app.example.test${pathname}`),
    headers: new Headers(),
    requestBody: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    buildId: 'build',
    basePath: '',
    pathnames: [pathname],
    routes: {
      beforeMiddleware: [rule],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [],
      onMatch: [],
      fallback: [],
    },
    invokeMiddleware: () => Promise.resolve({}),
  });
  return Object.fromEntries(result.resolvedHeaders ?? []);
}

/** The headers the edge gives it, for a deployment whose bundle says its Functions fill in one pass. */
function edgeHeaders({ rule, pathname }: Example): Record<string, string> {
  const manifest = buildProjectManifest({
    projectId: 'references',
    runId: 'run',
    generatedAt: '2026-10-07T00:00:00.000Z',
    originHost: 'app.example.test',
    deployment: { assetSetHash: 'a', observedAt: '2026-10-07T00:00:00.000Z' },
    app: { deploymentId: 'dpl_references', scriptName: 'app-references' },
    routes: [],
    headerRules: [{ sourceRegex: rule.sourceRegex, headers: rule.headers ?? {} }],
    routerReferences: 'one-pass',
  });
  return headerRulesFor(manifest, new URL(pathname, 'https://app.example.test'), new Headers())
    .headers;
}

/**
 * `replaceDestination` exactly as `@next/routing` 16.3.8 published it (`dist/index.js`; MIT, Vercel):
 * what the Functions of a deployment built before the runtime moved to 16.4's router fill
 * a header's references with, and keep filling them with until the deployment is built again. Run as
 * published, so the edge's filling for such a deployment is held to the router's own code rather
 * than to a reading of it.
 */
const REPLACE_DESTINATION_16_3_8 =
  // eslint-disable-next-line no-template-curly-in-string -- the published function's own template literals, as its text
  'function replaceDestination(e,t,n){let a=e;if(t){for(let e=1;e<t.length;e++){const n=t[e]??"";a=a.replace(new RegExp(`\\\\$${e}`,"g"),n)}if(t.groups){for(const[e,n]of Object.entries(t.groups)){a=a.replace(new RegExp(`\\\\$${e}`,"g"),n??"")}}}for(const[e,t]of Object.entries(n)){a=a.replace(new RegExp(`\\\\$${e}`,"g"),t)}return a}';

type ReplaceDestination = (
  template: string,
  match: RegExpExecArray,
  captures: Record<string, string>,
) => string;

function routerBefore(): ReplaceDestination {
  const sandbox: Record<string, unknown> = { RegExp, Object };
  // eslint-disable-next-line sonarjs/code-eval -- the published router's own function, run as published
  runInNewContext(
    `${REPLACE_DESTINATION_16_3_8}\nglobalThis.replace = replaceDestination;`,
    sandbox,
  );
  return sandbox['replace'] as ReplaceDestination;
}

/** The headers 16.3.8's router gives `pathname` for the rule, as a Function built with it does. */
function headersBefore({ rule, pathname }: Example): Record<string, string> {
  // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp -- as the router compiles it
  const match = new RegExp(rule.sourceRegex, 'i').exec(pathname);
  if (match === null) {
    return {};
  }
  const out: Record<string, string> = {};
  if (rule.headers === undefined) {
    return out;
  }
  const replace = routerBefore();
  const headers = Object.entries(rule.headers);
  for (const [name, value] of headers) {
    out[replace(name, match, {}).toLowerCase()] = replace(value, match, {});
  }
  return out;
}

/** The headers the edge gives it, for a deployment whose bundle says nothing of how it fills them. */
function edgeHeadersBefore({ rule, pathname }: Example): Record<string, string> {
  const manifest = buildProjectManifest({
    projectId: 'references',
    runId: 'run',
    generatedAt: '2026-10-07T00:00:00.000Z',
    originHost: 'app.example.test',
    deployment: { assetSetHash: 'a', observedAt: '2026-10-07T00:00:00.000Z' },
    app: { deploymentId: 'dpl_references', scriptName: 'app-references' },
    routes: [],
    headerRules: [{ sourceRegex: rule.sourceRegex, headers: rule.headers ?? {} }],
  });
  return headerRulesFor(manifest, new URL(pathname, 'https://app.example.test'), new Headers())
    .headers;
}

/** A capture that carries a replacement token of its own, which 16.3.8 reads as one. */
const TOKEN_IN_A_CAPTURE: Example = {
  rule: { sourceRegex: String.raw`^\/docs(?:\/([^\/]+?))$`, headers: { 'x-doc': '[$1]' } },
  pathname: '/docs/a$&b',
};

describe("the edge fills a deployment's header references as the router it was built with did", () => {
  it.each([...examples, TOKEN_IN_A_CAPTURE])('16.3.8: $rule.headers at $pathname', (example) => {
    expect(edgeHeadersBefore(example)).toStrictEqual(headersBefore(example));
  });
});

describe("the edge fills a header's references as the installed router does", () => {
  it.each(examples)('$rule.headers at $pathname', async (example) => {
    expect(edgeHeaders(example)).toStrictEqual(await routerHeaders(example));
  });
});
