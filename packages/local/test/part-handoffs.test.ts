import { kvGenerationKey } from '@stayingupwind/core/cache';
import { buildProjectManifest, type RouteEntry } from '@stayingupwind/core/manifest';
import {
  DEFAULT_DELIVERY_POLICY,
  runtimeCacheOf,
  type RuntimeCacheSettings,
} from '@stayingupwind/host/delivery';
import { describe, expect, it } from 'vitest';

import type { CheckedStack, KeptMiddlewareResult } from '../src/answers.ts';
import { APPLICATIONS, handedOnVerdict } from '../src/part-handoffs.ts';
import type { Part } from '../src/part-marks.ts';
import type { RecordedGeneration } from '../src/workers/protocol.ts';

/**
 * A page's whole payload the edge handed on before the middleware ran (`rsc-payload-ahead`), judged
 * as the edge judges one it could only hand on after it (`payload-ahead.ts` in the edge): by the
 * route, the policy, the request and the generations the edge read — no running stack needed.
 */

const SITE = new URL('https://site.example');
const AT = '2026-10-28T00:00:00.000Z';
const SCOPE = 'dpl_site';
const SHELL = {
  sha256: 'a'.repeat(64),
  byteLength: 1,
  contentType: 'text/html',
  encoding: 'identity',
} as const;
const AHEAD = 'passthrough;reason=rsc-payload-ahead';
/** A page the build finished, whose record a render since may have left needing a resume. */
const FINISHED: RouteEntry = {
  pathname: '/',
  status: 200,
  shell: SHELL,
  headers: {},
  cache: { entryId: 'front-entry', kind: 'app-page', delivery: 'complete' },
};
/** A class the build made a shell of, whose record proves no member's Flight. */
const CLASS: RouteEntry = {
  pathname: '/items/[id]',
  status: 200,
  shell: SHELL,
  headers: {},
  cache: { entryId: 'items-entry', kind: 'app-page', delivery: 'resume' },
};
/** A class the build left a partial fallback, whose members the edge answers from completions. */
const FALLBACK: RouteEntry = {
  pathname: '/posts/[slug]',
  status: 200,
  shell: SHELL,
  headers: {},
  partialFallback: { route: '/posts/[slug]' },
};
const MANIFEST = buildProjectManifest({
  projectId: 'site',
  runId: 'run',
  generatedAt: AT,
  originHost: SITE.hostname,
  deployment: { assetSetHash: 'a'.repeat(64), observedAt: AT, dplId: SCOPE },
  app: { deploymentId: SCOPE, scriptName: 'app', middlewareScriptName: 'middleware' },
  routes: [FINISHED, CLASS, FALLBACK],
  cache: { keySchemaVersion: 1, scopeId: SCOPE },
});

/** A generation of the finished page's record, as the stack's edge read it for the request. */
function readAs(partial: boolean): ReadonlyMap<string, RecordedGeneration> {
  const generation: RecordedGeneration = { headers: {}, artifacts: [], partial, source: 'runtime' };
  return new Map([[`${kvGenerationKey(SCOPE, 'front-entry')}|2`, generation]]);
}

function stackOf(
  read?: ReadonlyMap<string, RecordedGeneration>,
  settings: Partial<RuntimeCacheSettings> = {},
): CheckedStack {
  const runtimeCache = { ...runtimeCacheOf(DEFAULT_DELIVERY_POLICY), ...settings };
  return {
    site: SITE,
    manifest: MANIFEST,
    policy: { ...DEFAULT_DELIVERY_POLICY, runtimeCache },
    generationEvidence: read,
  } as CheckedStack;
}

/** A router's request for `route`'s whole payload at `pathname`, prefetched as `prefetch` says. */
function payloadOf(route: RouteEntry, pathname: string, prefetch?: string): Part {
  return {
    kind: 'payload',
    what: 'its whole payload',
    url: new URL(`${pathname}?_rsc=abc`, SITE),
    headers: { rsc: '1', ...(prefetch !== undefined && { 'next-router-prefetch': prefetch }) },
    route,
    built: undefined,
    builtOn: (shelled) => shelled.payload?.artifact,
    exact: true,
  };
}

function judged(
  stack: CheckedStack,
  part: Part,
  read: { readonly covered?: boolean; readonly decided?: KeptMiddlewareResult } = {},
) {
  return handedOnVerdict(stack, part, {
    answered: AHEAD,
    decided: read.decided,
    covered: read.covered ?? true,
    asked: part.headers,
  });
}

/** What a failure of a payload handed on before the middleware says, after `handed on, `. */
function aheadFailure(reason: string) {
  return {
    kind: 'failed',
    reason: `handed on, before the middleware ran, though ${reason} (x-arkor-edge: ${AHEAD})`,
  };
}

describe('a payload the edge hands on before the middleware ran', () => {
  it.each(['navigation', '2', '3'])(
    "is the application's where the record the edge read holds a resume: %s",
    (prefetch) => {
      const part = payloadOf(FINISHED, '/', prefetch === 'navigation' ? undefined : prefetch);
      const resumed = stackOf(readAs(true));

      expect(judged(resumed, part)).toStrictEqual({
        kind: 'skipped',
        reason: APPLICATIONS,
      });
    },
  );

  it('fails where no generation the edge read holds a resume, of a page the build finished', () => {
    const reason =
      'the build finished the page, and no generation of its record the edge read holds a resume';
    const page = payloadOf(FINISHED, '/');
    const whole = stackOf(readAs(false));

    expect(judged(whole, page)).toStrictEqual(aheadFailure(reason));
    expect(judged(stackOf(), page)).toStrictEqual(aheadFailure(reason));
  });

  it('fails as a static prefetch, or under a policy that holds no record', () => {
    const resumed = readAs(true);
    const prefetched = payloadOf(FINISHED, '/', '1');
    const unheld = stackOf(resumed, { holdMs: 0 });

    expect(judged(stackOf(resumed), prefetched)).toStrictEqual(
      aheadFailure('it is a static prefetch, which saved partial Flight answers'),
    );
    expect(judged(unheld, payloadOf(FINISHED, '/'))).toStrictEqual(
      aheadFailure(
        'the policy holds no record, which the edge judges a payload by only once it read it',
      ),
    );
  });

  it("is the application's for a member of a class, but where the policy reads the member's own record", () => {
    const member = payloadOf(CLASS, '/items/one');

    expect(judged(stackOf(), member)).toStrictEqual({ kind: 'skipped', reason: APPLICATIONS });
    expect(judged(stackOf(undefined, { concreteUpgrade: true }), member)).toStrictEqual(
      aheadFailure("the policy reads the member's own record, which the edge may answer it from"),
    );
  });

  it("fails for a partial fallback's member, which the edge answers from its completion", () => {
    expect(judged(stackOf(), payloadOf(FALLBACK, '/posts/first'))).toStrictEqual(
      aheadFailure(
        "the edge answers its route's parts from what the build wrote, or from its partial fallback's completions",
      ),
    );
  });

  it('fails where no matcher covers the request, or where the stack kept what the middleware decided', () => {
    const member = payloadOf(CLASS, '/items/one');
    const decided: KeptMiddlewareResult = {
      kind: 'continue',
      url: member.url,
      rewritten: false,
      requestHeaders: new Headers(member.headers),
      responseHeaders: new Headers(),
      setCookie: undefined,
    };

    expect(judged(stackOf(), member, { covered: false })).toStrictEqual(
      aheadFailure('no matcher of the build covers the request'),
    );
    expect(judged(stackOf(), member, { decided })).toStrictEqual(
      aheadFailure('the stack kept what the middleware decided for it'),
    );
  });
});
