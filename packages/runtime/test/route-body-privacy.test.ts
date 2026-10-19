import { generationResponseHeaders } from '@stayingupwind/core/cache';
import { describe, expect, it, vi } from 'vitest';

import { answerHeaders } from '../src/representations.ts';

// No Node bridge is called by header delivery.
vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));

const HTTP_OK = 200;

describe('route-body storage and Function delivery', () => {
  it('keeps the host privacy veto without authorizing shared Function responses', () => {
    const recorded = generationResponseHeaders('app-route', HTTP_OK, [
      ['content-type', 'image/png'],
      ['cache-control', 'public, max-age=60'],
      ['set-cookie', 'session=not-recorded'],
    ]);
    const answered = answerHeaders('route-body', recorded, false);
    const formerlyPublic = answerHeaders(
      'route-body',
      { 'content-type': 'image/png', 'cache-control': 'public' },
      false,
    );

    expect(recorded['cache-control']).toBe('private, no-store');
    expect(recorded).not.toHaveProperty('set-cookie');
    expect(answered.get('cache-control')).toBe('private, no-store');
    expect(answered.get('content-type')).toBe('image/png');
    expect(answered.has('set-cookie')).toBe(false);
    expect(formerlyPublic.get('cache-control')).toBe('private, no-store');
  });
});
