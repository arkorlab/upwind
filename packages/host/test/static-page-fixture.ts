import type { DeploymentBundle, Prerender } from '@stayingupwind/core/bundle';
import { RSC_VARY } from '@stayingupwind/core/request';

import { shellBundle } from './shared-shell-fixture.ts';

export const STATIC_PAGE: Prerender = {
  id: 'something',
  route: '/something',
  pathname: '/something',
  parentOutputId: '/something',
  groupId: 1,
  routeType: 'page',
  response: 'complete',
  compute: 'static',
  renderingMode: 'STATIC',
  body: { sha256: 'a'.repeat(64), byteLength: 100, contentType: 'text/html; charset=utf-8' },
  initialStatus: 200,
  initialHeaders: { 'content-type': 'text/html; charset=utf-8', vary: RSC_VARY },
  initialRevalidate: false,
  allowHeader: [
    'host',
    'x-matched-path',
    'x-prerender-revalidate',
    'x-prerender-revalidate-if-generated',
    'x-next-revalidated-tags',
    'x-next-revalidate-tag-token',
  ],
};

export function staticPageBundle(prerender = STATIC_PAGE, enabled = true): DeploymentBundle {
  return {
    ...shellBundle(prerender, 'pages'),
    deploymentId: 'dpl_static_pages',
    ...(enabled && { staticPagesPrivacy: 1 }),
    entrypoints: [{ id: prerender.route, kind: 'pages', pathname: prerender.route }],
  };
}

export const ISR_PAGE: Prerender = { ...STATIC_PAGE, initialRevalidate: 2 };

export function isrPageBundle(prerender = ISR_PAGE): DeploymentBundle {
  return { ...staticPageBundle(prerender), staticPagesPrivacy: 2 };
}
