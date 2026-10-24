import { describe, expect, it } from 'vitest';

import type { RouteHas } from '../src/bundle/schema.ts';
import { buildProjectManifest } from '../src/manifest/manifest.ts';
import {
  bypassForHolds,
  passesOnEveryAgent,
  wantsBlockingMetadata,
} from '../src/request/blocking-metadata.ts';
import {
  anyConditionHolds,
  conditionsHold,
  mayHoldForDocument,
} from '../src/request/conditions.ts';
import { ROUTER_REQUEST_HEADERS } from '../src/request/constants.ts';

const url = new URL('https://app.example.test/page?preview=1');

/** What Next.js emits as a PPR route's `bypassFor`: any one of these skips the cache. */
const bypassFor: RouteHas[] = [
  { type: 'header', key: 'next-action' },
  { type: 'header', key: 'content-type', value: 'multipart/form-data;.*' },
];

describe('route conditions', () => {
  it('bypass on any one condition, as Next.js reads a prerender bypass list', () => {
    expect(anyConditionHolds(bypassFor, url, new Headers({ 'next-action': 'abc' }))).toBe(true);
    expect(
      anyConditionHolds(
        bypassFor,
        url,
        new Headers({ 'content-type': 'multipart/form-data; boundary=x' }),
      ),
    ).toBe(true);
    expect(anyConditionHolds(bypassFor, url, new Headers({ 'content-type': 'text/plain' }))).toBe(
      false,
    );
    expect(anyConditionHolds([], url, new Headers())).toBe(false);
  });

  it('require every condition of a rule, unlike a bypass list', () => {
    expect(conditionsHold({ has: bypassFor }, url, new Headers({ 'next-action': 'abc' }))).toBe(
      false,
    );
    expect(
      conditionsHold({ has: [{ type: 'query', key: 'preview', value: '1' }] }, url, new Headers()),
    ).toBe(true);
  });

  it.each([
    { value: 'admin', supplied: 'superadmin', matches: true },
    { value: '^admin$', supplied: 'superadmin', matches: false },
    { value: '(?<role>admin)', supplied: 'superadmin', matches: true },
    { value: '[', supplied: '[', matches: true },
    { value: '[', supplied: 'other', matches: false },
  ])('matches @next/routing regex behavior: $value against $supplied', (example) => {
    const condition: RouteHas = { type: 'header', key: 'x-role', value: example.value };
    const headers = new Headers({ 'x-role': example.supplied });

    expect(conditionsHold({ has: [condition] }, url, headers)).toBe(example.matches);
    expect(conditionsHold({ missing: [condition] }, url, headers)).toBe(!example.matches);
    expect(anyConditionHolds([condition], url, headers)).toBe(example.matches);
  });

  it.each([
    { condition: { type: 'header', key: 'x-empty' }, cookie: '', matches: false },
    { condition: { type: 'query', key: 'empty' }, cookie: '', matches: false },
    { condition: { type: 'cookie', key: 'empty' }, cookie: 'empty=', matches: true },
    {
      condition: { type: 'cookie', key: 'role', value: '^admin$' },
      cookie: 'role=user; role=admin',
      matches: true,
    },
    {
      condition: { type: 'cookie', key: 'role', value: '^admin$' },
      cookie: 'role=admin; role=user',
      matches: false,
    },
    { condition: { type: 'cookie', key: 'role' }, cookie: 'role =admin', matches: false },
    {
      condition: { type: 'cookie', key: 'token', value: '^a=b$' },
      cookie: 'token=a=b',
      matches: true,
    },
  ] as const)(
    'matches @next/routing presence and cookie rules: $condition with $cookie',
    (example) => {
      const headers = new Headers({ 'x-empty': '', cookie: example.cookie });
      const asked = new URL('https://app.example.test/page?empty=');

      expect(conditionsHold({ has: [example.condition] }, asked, headers)).toBe(example.matches);
      expect(conditionsHold({ missing: [example.condition] }, asked, headers)).toBe(
        !example.matches,
      );
    },
  );

  /**
   * The substring attempt is the expensive one — it is tried from every position, where the
   * whole-value one is tried from a single one — so it is the half that is bounded. Everything a
   * routing rule is written about is answered exactly as Next.js answers it, however long the
   * value: these are the cases four rounds of review asked about.
   */
  describe('a value longer than the substring attempt is made against', () => {
    const asked = new URL('https://app.example.test/page');
    const long = 'a'.repeat(4097);

    it('still matches a pattern that matches the whole value', () => {
      const bearer: RouteHas = { type: 'header', key: 'authorization', value: 'Bearer .*' };
      const headers = new Headers({ authorization: `Bearer ${long}` });

      expect(conditionsHold({ has: [bearer] }, asked, headers)).toBe(true);
      expect(conditionsHold({ missing: [bearer] }, asked, headers)).toBe(false);
    });

    it('still bypasses the cache for a bypass list that names it', () => {
      const bypass: RouteHas[] = [
        { type: 'header', key: 'content-type', value: 'multipart/form-data;.*' },
      ];
      const oversized = new Headers({ 'content-type': `multipart/form-data; boundary=${long}` });

      expect(anyConditionHolds(bypass, asked, oversized)).toBe(true);
    });

    it('still satisfies a `missing` the value does not match, so the rule applies', () => {
      const trusted: RouteHas = { type: 'header', key: 'x-skip', value: '^trusted$' };

      expect(conditionsHold({ missing: [trusted] }, asked, new Headers({ 'x-skip': long }))).toBe(
        true,
      );
      expect(
        conditionsHold({ missing: [trusted] }, asked, new Headers({ 'x-skip': 'trusted' })),
      ).toBe(false);
    });

    /** What is given up, and all of it: a pattern that matches only within such a value. */
    it('does not look for a pattern inside it', () => {
      const inside: RouteHas = { type: 'header', key: 'x-flag', value: 'needle' };

      expect(conditionsHold({ has: [inside] }, asked, new Headers({ 'x-flag': 'a needle' }))).toBe(
        true,
      );
      expect(
        conditionsHold({ has: [inside] }, asked, new Headers({ 'x-flag': `${long}needle` })),
      ).toBe(false);
    });
  });
});

/**
 * A request carrying one of the client router's own headers is never answered with a document, so
 * a rule that requires one never holds for a document — whatever it asks of the value, however it
 * spells the name. Anything else is a condition a document request may meet.
 */
describe('conditions a document may meet', () => {
  it.each(ROUTER_REQUEST_HEADERS)('never meets a rule that requires %s', (name) => {
    expect(mayHoldForDocument({ has: [{ type: 'header', key: name }] })).toBe(false);
    expect(mayHoldForDocument({ has: [{ type: 'header', key: name.toUpperCase() }] })).toBe(false);
    expect(
      mayHoldForDocument({
        has: [
          { type: 'cookie', key: 'beta' },
          { type: 'header', key: name, value: '1' },
        ],
      }),
    ).toBe(false);
  });

  it('may meet any other rule, a `missing` of the same headers included', () => {
    expect(mayHoldForDocument({})).toBe(true);
    expect(mayHoldForDocument({ has: [{ type: 'header', key: 'x-beta' }] })).toBe(true);
    expect(mayHoldForDocument({ has: [{ type: 'header', key: 'next-url' }] })).toBe(true);
    expect(mayHoldForDocument({ has: [{ type: 'query', key: 'rsc' }] })).toBe(true);
    expect(mayHoldForDocument({ has: [{ type: 'cookie', key: 'rsc' }] })).toBe(true);
    expect(mayHoldForDocument({ missing: [{ type: 'header', key: 'rsc' }] })).toBe(true);
  });
});

/** A manifest whose application's `htmlLimitedBots` is `pattern`; `undefined` records none. */
function manifestUnder(pattern: string | undefined) {
  const observedAt = '2026-09-15T00:00:00.000Z';
  return buildProjectManifest({
    projectId: 'p',
    runId: 'r',
    generatedAt: observedAt,
    originHost: 'app.example.test',
    deployment: { assetSetHash: 'h', observedAt },
    routes: [],
    app: { deploymentId: 'dpl_1', scriptName: 'app' },
    ...(pattern !== undefined && { htmlLimitedBots: pattern }),
  });
}

/**
 * A manifest made before the list was recorded, whose one route carries the crawler condition
 * `next build` wrote from `pattern`: what such a manifest's list is read off.
 */
function recordingNone(pattern: string) {
  const observedAt = '2026-09-15T00:00:00.000Z';
  return buildProjectManifest({
    projectId: 'p',
    runId: 'r',
    generatedAt: observedAt,
    originHost: 'app.example.test',
    deployment: { assetSetHash: 'h', observedAt },
    routes: [
      {
        pathname: '/docs',
        status: 200,
        shell: {
          sha256: 'a'.repeat(64),
          byteLength: 10,
          contentType: 'text/html',
          encoding: 'identity',
        },
        headers: {},
        bypassFor: [{ type: 'header', key: 'user-agent', value: pattern }],
      },
    ],
    app: { deploymentId: 'dpl_1', scriptName: 'app' },
  });
}

/** Next.js's own list, as `next build` writes it into a route where the application names none. */
const NEXT_LIST = String.raw`[\w-]+-Google|Google-[\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight`;

function agent(userAgent: string): Headers {
  return new Headers({ 'user-agent': userAgent });
}

/** A route whose `bypassFor` is the user-agent condition `next build` writes, and nothing else. */
function crawlerCondition(
  pattern: string,
  delivery?: 'resume' | 'complete',
): Parameters<typeof bypassForHolds>[0] {
  return {
    bypassFor: [{ type: 'header', key: 'user-agent', value: pattern }],
    ...(delivery !== undefined && { cache: { entryId: 'e', kind: 'app-page', delivery } }),
  };
}

describe('a prerender’s bypassFor, as the edge judges it', () => {
  /**
   * The condition `next build` writes from the list is asked of the judge the classification asks,
   * which is case-insensitive, as Next.js tests the list, where the router's reading is not.
   */
  it('judges the condition Next.js writes from the list by the list', () => {
    for (const pattern of [undefined, '']) {
      const manifest = manifestUnder(pattern);

      expect(
        bypassForHolds(crawlerCondition(NEXT_LIST), url, agent('twitterbot/1.0'), manifest),
      ).toBe(true);
      expect(
        anyConditionHolds(
          crawlerCondition(NEXT_LIST).bypassFor ?? [],
          url,
          agent('twitterbot/1.0'),
        ),
      ).toBe(false);
      expect(bypassForHolds(crawlerCondition(NEXT_LIST), url, agent('Mozilla/5.0'), manifest)).toBe(
        false,
      );
    }
    const own = manifestUnder('MyBot');

    expect(bypassForHolds(crawlerCondition('MyBot'), url, agent('mybot/1.0'), own)).toBe(true);
    expect(bypassForHolds(crawlerCondition('MyBot'), url, agent('Twitterbot/1.0'), own)).toBe(
      false,
    );
  });

  /**
   * A list the edge will not run is run in neither place, and any agent may be one it names: a
   * shell resumed for such a visitor would be resumed with the blocking metadata tree. Every agent
   * is passed on, the one Next.js would stream to with that list included — a render the Worker
   * does for nothing, taken knowingly over a page whose metadata never arrives. A request that
   * names no agent is streamed to, as Next.js streams to it.
   */
  it('names every agent in the condition under a list the edge will not run', () => {
    const refused = '(?:MyBot|Crawler+)+';
    const grouped = manifestUnder(refused);

    for (const userAgent of ['MyBot/1.0', 'Twitterbot/1.0', 'Mozilla/5.0 Chrome/140']) {
      expect(bypassForHolds(crawlerCondition(refused), url, agent(userAgent), grouped)).toBe(true);
    }

    expect(bypassForHolds(crawlerCondition(refused), url, new Headers(), grouped)).toBe(false);
  });

  /** A list simplified to one the edge runs is run in the condition as in the classification. */
  it('runs a simplified list in the condition, naming whom the list as written names', () => {
    const simplified = manifestUnder('.*(bot|crawler).*');

    expect(
      bypassForHolds(crawlerCondition('.*(bot|crawler).*'), url, agent('SomeBot/1.0'), simplified),
    ).toBe(true);
    expect(
      bypassForHolds(
        crawlerCondition('.*(bot|crawler).*'),
        url,
        agent('Mozilla/5.0 Chrome/140'),
        simplified,
      ),
    ).toBe(false);
  });

  /**
   * Of a page the build finished the condition is not asked: what Next.js renders for the visitor
   * is the finished document. The rest of its `bypassFor` still is.
   */
  it('does not ask the condition of a page the build finished', () => {
    const own = manifestUnder('MyBot');
    const refused = '(?:MyBot|Crawler+)+';
    const grouped = manifestUnder(refused);

    expect(
      bypassForHolds(crawlerCondition('MyBot', 'complete'), url, agent('MyBot/1.0'), own),
    ).toBe(false);
    expect(
      bypassForHolds(crawlerCondition(refused, 'complete'), url, agent('MyBot/1.0'), grouped),
    ).toBe(false);
    expect(bypassForHolds(crawlerCondition('MyBot', 'resume'), url, agent('MyBot/1.0'), own)).toBe(
      true,
    );

    const finished: Parameters<typeof bypassForHolds>[0] = {
      bypassFor,
      cache: { entryId: 'e', kind: 'app-page', delivery: 'complete' },
    };

    expect(bypassForHolds(finished, url, new Headers({ 'next-action': 'abc' }), own)).toBe(true);
  });

  /**
   * A manifest made before the list was recorded still carries the condition `next build` wrote
   * from it: judged as the list, by its own pattern — case-insensitively, and naming every agent
   * where the pattern will not run — as a manifest that records it would be.
   */
  it('judges the crawler condition of a manifest that records no list by its own pattern', () => {
    const unrecorded = recordingNone('MyBot');
    const refused = 'MyBot|a.*.*.*.*!';

    expect(bypassForHolds(crawlerCondition('MyBot'), url, agent('mybot/1.0'), unrecorded)).toBe(
      true,
    );
    expect(
      bypassForHolds(crawlerCondition('MyBot'), url, agent('Mozilla/5.0 Chrome/140'), unrecorded),
    ).toBe(false);
    expect(
      bypassForHolds(
        crawlerCondition(refused),
        url,
        agent('Mozilla/5.0 Chrome/140'),
        recordingNone(refused),
      ),
    ).toBe(true);
    expect(
      bypassForHolds(crawlerCondition('MyBot', 'complete'), url, agent('mybot/1.0'), unrecorded),
    ).toBe(false);
    expect(bypassForHolds(crawlerCondition('MyBot'), url, new Headers(), unrecorded)).toBe(false);
  });

  /**
   * Next.js 16.4 writes the condition wrapped to be found anywhere in the agent
   * (`.*(?:pattern).*`), as its route matchers anchor a header's value. Wrapped, it is still the
   * list: judged as the list is, never run as written — case-insensitively, naming every agent where
   * the list will not run, and not asked of a page the build finished.
   */
  it('judges the list condition Next.js 16.4 writes wrapped as the list', () => {
    const own = manifestUnder('MyBot');
    const refusedList = 'MyBot|a.*.*.*.*!';

    expect(bypassForHolds(crawlerCondition('.*(?:MyBot).*'), url, agent('mybot/1.0'), own)).toBe(
      true,
    );
    expect(
      bypassForHolds(crawlerCondition('.*(?:MyBot).*'), url, agent('Mozilla/5.0 Chrome/140'), own),
    ).toBe(false);
    expect(
      bypassForHolds(
        crawlerCondition(`.*(?:${refusedList}).*`),
        url,
        agent('Mozilla/5.0 Chrome/140'),
        manifestUnder(refusedList),
      ),
    ).toBe(true);
    expect(
      bypassForHolds(crawlerCondition('.*(?:MyBot).*', 'complete'), url, agent('mybot/1.0'), own),
    ).toBe(false);
    expect(
      bypassForHolds(
        crawlerCondition('.*(?:MyBot).*'),
        url,
        agent('mybot/1.0'),
        recordingNone('.*(?:MyBot).*'),
      ),
    ).toBe(true);
  });

  /**
   * Next.js 16.3 writes the application's list as it is, and a list may have the wrapper's own shape.
   * Written as it is, the condition is still the list the manifest records: judged as the list, and
   * not asked of a page the build finished — never stripped of a wrapper Next.js did not put on it,
   * taken for another pattern, and run as written.
   */
  it('judges a list of the wrapper’s own shape that Next.js 16.3 writes as it is as the list', () => {
    const shaped = '.*(?:MyBot).*';
    const own = manifestUnder(shaped);

    expect(bypassForHolds(crawlerCondition(shaped), url, agent('mybot/1.0'), own)).toBe(true);
    expect(
      bypassForHolds(crawlerCondition(shaped), url, agent('Mozilla/5.0 Chrome/140'), own),
    ).toBe(false);
    expect(bypassForHolds(crawlerCondition(shaped, 'complete'), url, agent('MyBot/1.0'), own)).toBe(
      false,
    );
  });

  /**
   * Every agent is passed on only where the list names every agent there is: one the edge will not
   * run, or one an alternative of which says nothing (`.*`). A list that names many agents, every
   * browser a run might try among them, still leaves some agent the shell.
   */
  it('knows a list that passes every agent on from one that names many', () => {
    const many = 'my-prover|Windows|iPhone|Linux|Macintosh';

    expect(passesOnEveryAgent(crawlerCondition('.*'), manifestUnder('.*'))).toBe(true);
    expect(passesOnEveryAgent(crawlerCondition('MyBot|.*'), manifestUnder('MyBot|.*'))).toBe(true);
    expect(
      passesOnEveryAgent(crawlerCondition('MyBot|a.*.*.*.*!'), manifestUnder('MyBot|a.*.*.*.*!')),
    ).toBe(true);
    expect(passesOnEveryAgent(crawlerCondition(many), manifestUnder(many))).toBe(false);
    expect(passesOnEveryAgent(crawlerCondition(NEXT_LIST), recordingNone(NEXT_LIST))).toBe(false);
    expect(passesOnEveryAgent(crawlerCondition('.*'), recordingNone('.*'))).toBe(true);
    expect(passesOnEveryAgent(crawlerCondition('.*', 'complete'), manifestUnder('.*'))).toBe(false);
  });

  /**
   * A list may name every agent and simplify to something all the same: an alternative that matches
   * while taking nothing (`a*`, `^`, `$`, `^.*$`), or one character, which every agent has (`.+`).
   * Such a list passes every agent on as surely as `.*`, and is told for one; one that takes more,
   * or holds the match to the whole agent, names some agents only.
   */
  it('knows a list that names every agent though it simplifies to something', () => {
    const agents = [
      'a',
      '-',
      'Mozilla/5.0 Chrome/141',
      'Twitterbot/1.0',
      `Mozilla/5.0 ${'x'.repeat(600)}`,
    ];
    const all = ['a*', 'x?|MyBot', '^', '$', '^.*$', '.*$', '.+', '^.+$', '^a*.', '.b*$'];
    const some: [pattern: string, unnamed: string][] = [
      ['^$', 'a'],
      ['^.$', 'ab'],
      ['..', 'a'],
      ['^a*$', 'b'],
      ['$.', 'a'],
      ['.^', 'a'],
      [String.raw`\b`, '-'],
      ['a', 'b'],
    ];

    for (const pattern of all) {
      const manifest = manifestUnder(pattern);

      expect([pattern, passesOnEveryAgent(crawlerCondition(pattern), manifest)]).toStrictEqual([
        pattern,
        true,
      ]);

      for (const userAgent of agents) {
        expect([pattern, userAgent, wantsBlockingMetadata(userAgent, manifest)]).toStrictEqual([
          pattern,
          userAgent,
          true,
        ]);
      }
    }
    for (const [pattern, unnamed] of some) {
      const manifest = manifestUnder(pattern);

      expect([pattern, passesOnEveryAgent(crawlerCondition(pattern), manifest)]).toStrictEqual([
        pattern,
        false,
      ]);
      expect([pattern, wantsBlockingMetadata(unnamed, manifest)]).toStrictEqual([pattern, false]);
    }
  });

  /** Only that one condition: any other is read as Next.js's router reads it. */
  it('reads every other condition as the router does', () => {
    const manifest = manifestUnder('MyBot');

    expect(
      bypassForHolds({ bypassFor }, url, new Headers({ 'next-action': 'abc' }), manifest),
    ).toBe(true);
    expect(bypassForHolds(crawlerCondition('Special'), url, agent('Special/1.0'), manifest)).toBe(
      true,
    );
    expect(bypassForHolds(crawlerCondition('Special'), url, agent('special/1.0'), manifest)).toBe(
      false,
    );
    expect(
      bypassForHolds(crawlerCondition(NEXT_LIST), url, agent('twitterbot/1.0'), manifest),
    ).toBe(false);
    expect(bypassForHolds({}, url, agent('MyBot/1.0'), manifest)).toBe(false);
  });
});
