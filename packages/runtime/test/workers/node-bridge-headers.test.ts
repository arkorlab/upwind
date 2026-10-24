import { describe, expect, it } from 'vitest';

import type { NodeHandler } from '../../src/app-module.ts';
import { invokeNodeHandler } from '../../src/node-bridge.ts';

/**
 * The headers a Node.js handler is handed, as workerd's `node:http` server builds them.
 *
 * workerd takes a comma in a header Node.js keeps one of for the join of a repeated one, and hands
 * the handler what comes before it. A browser's `User-Agent` has a comma of its own, and so does
 * every HTTP date: Next.js was told a crawler's agent up to `(KHTML`, did not tell an HTML-limited
 * one from a browser by what was left, and streamed it metadata it blocks for such a crawler
 * (`app-dir/metadata-streaming`, "Google speed insights bot").
 */

const AGENT =
  'Mozilla/5.0 (Linux; Android 7.0; Moto G (4)) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/94.0.4590.2 Mobile Safari/537.36 Chrome-Lighthouse';
const SINCE = 'Wed, 21 Oct 2015 07:28:00 GMT';

/** Answers with the headers it was handed, as a handler reads them. */
const echo: NodeHandler = (req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      agent: req.headers['user-agent'],
      since: req.headers['if-modified-since'],
      accept: req.headers.accept,
      raw: req.rawHeaders,
    }),
  );
  return Promise.resolve();
};

describe('the headers a Node.js handler is handed', () => {
  it('carry a header Node.js keeps one of whole, commas and all', async () => {
    const response = await invokeNodeHandler({
      handler: echo,
      request: new Request('https://app.test/page', {
        headers: {
          'user-agent': AGENT,
          'if-modified-since': SINCE,
          accept: 'text/html, application/xhtml+xml',
        },
      }),
      requestMeta: {},
      waitUntil: () => {
        // Nothing is left to run.
      },
    });

    const seen = (await response.json()) as Record<string, unknown>;

    expect(seen).toMatchObject({
      agent: AGENT,
      since: SINCE,
      accept: 'text/html, application/xhtml+xml',
    });
    expect(seen['raw']).toStrictEqual(expect.arrayContaining([AGENT, SINCE]));
  });
});
