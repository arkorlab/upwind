import { EDGE_DEBUG_HEADER } from '@stayingupwind/core/request';
import { describe, expect, it } from 'vitest';

import { failedChecks } from '../../src/preview/checks.ts';

const SITE = new URL('http://localhost:3000/');

/** A site answering each path as the map says, and failing a path it does not name. */
function site(answers: ReadonlyMap<string, () => Response>): typeof fetch {
  return (input) => {
    const { pathname } = new URL(input instanceof Request ? input.url : String(input));
    const answer = answers.get(pathname);
    return answer === undefined
      ? Promise.reject(new Error('connection refused'))
      : Promise.resolve(answer());
  };
}

describe('the paths a deploy asks, asked of a preview', () => {
  it('pass where each is answered short of a server error', async () => {
    const fetchImpl = site(
      new Map([
        ['/', () => new Response('home')],
        ['/gone', () => new Response('missing', { status: 404 })],
        ['/moved', () => new Response(null, { status: 308, headers: { location: '/' } })],
      ]),
    );

    await expect(failedChecks(SITE, ['/', '/gone', '/moved'], fetchImpl)).resolves.toStrictEqual(
      [],
    );
  });

  it('fail on a server error, on no deployment, and where nothing answers', async () => {
    const fetchImpl = site(
      new Map([
        ['/broken', () => new Response('error', { status: 502 })],
        [
          '/empty',
          () => {
            return new Response('none', {
              headers: { [EDGE_DEBUG_HEADER]: 'mode=edge; reason=no-pointer' },
            });
          },
        ],
      ]),
    );

    await expect(
      failedChecks(SITE, ['/broken', '/empty', '/unreached'], fetchImpl),
    ).resolves.toStrictEqual([
      '/broken was answered with 502',
      '/empty was answered with no deployment',
      '/unreached was not answered: connection refused',
    ]);
  });
});
