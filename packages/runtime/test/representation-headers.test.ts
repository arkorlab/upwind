import { describe, expect, it, vi } from 'vitest';

import { answerHeaders, type Representation } from '../src/representations.ts';

// Header construction does not render through Cloudflare's Node bridge.
vi.mock(import('../src/node-bridge.ts'), () => {
  return {
    invokeNodeHandler: () => {
      throw new Error('unexpected Node render');
    },
  };
});

const PRELOAD = '</_next/static/media/geist.woff2>; rel=preload; as=font; crossorigin';

/** Resource hints recorded for a document must not be replayed on its other Flight outputs. */
describe('resource hints recorded with a generation', () => {
  it.each(['rsc', 'segment:/_tree'] as const)('omits document Link on %s', (representation) => {
    for (const name of ['link', 'Link', 'LiNk']) {
      const headers = answerHeaders(
        representation,
        { [name]: PRELOAD, 'x-recorded': 'kept' },
        true,
      );

      expect(headers.has('link')).toBe(false);
      expect(headers.get('x-recorded')).toBe('kept');
    }
  });

  it.each<{ representation: Representation; contentType: string }>([
    { representation: 'html', contentType: 'text/html; charset=utf-8' },
    { representation: 'pages-data', contentType: 'application/json; charset=utf-8' },
    { representation: 'route-body', contentType: 'text/x-component' },
  ])('keeps recorded Link on $representation', ({ representation, contentType }) => {
    const headers = answerHeaders(
      representation,
      { Link: PRELOAD, 'content-type': 'text/x-component', 'x-recorded': 'kept' },
      false,
    );

    expect(headers.get('link')).toBe(PRELOAD);
    expect(headers.get('x-recorded')).toBe('kept');
    expect(headers.get('content-type')).toBe(contentType);
  });
});
