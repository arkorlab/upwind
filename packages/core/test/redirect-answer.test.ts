import { describe, expect, it } from 'vitest';

import { redirectAnswer } from '../src/request/redirect-answer.ts';

describe('a redirect with no body of its own', () => {
  it('is answered with its destination, and a Refresh where it is permanent', async () => {
    const permanent = redirectAnswer('/docs/hello', 308, new Headers({ location: '/docs/hello' }));
    const temporary = redirectAnswer('/login', 307, new Headers({ location: '/login' }));

    expect(permanent.status).toBe(308);
    expect(permanent.headers.get('refresh')).toBe('0;url=/docs/hello');
    await expect(permanent.text()).resolves.toBe('/docs/hello');
    expect(temporary.headers.get('refresh')).toBeNull();
    await expect(temporary.text()).resolves.toBe('/login');
  });

  it('adds no content type Next.js does not send', () => {
    const answer = redirectAnswer('/docs', 308, new Headers({ location: '/docs' }));

    expect(answer.headers.get('content-type')).toBeNull();
    expect(answer.headers.get('location')).toBe('/docs');
  });
});
