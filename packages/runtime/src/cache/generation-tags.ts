import {
  appPathFor,
  implicitTagsFor,
  parseCacheTagsHeader,
  type RouteEntryDescriptor,
  sharedShellTagOf,
} from '@stayingupwind/core/cache';

import { isClassShell } from '../store.ts';
import type { CapturedRender } from './capture.ts';

/** The render's tags and the implicit identities under which its entry can be invalidated. */
export function generationTagValues(
  descriptor: RouteEntryDescriptor,
  render: CapturedRender,
  entryId: string,
): Set<string> {
  const recorded = parseCacheTagsHeader(render.headers['x-next-cache-tags']);
  const concrete = descriptor.pathname.includes('[') ? undefined : descriptor.pathname;
  const implicit =
    descriptor.kind === 'pages'
      ? []
      : implicitTagsFor(appPathFor(descriptor.kind, descriptor.route), concrete);
  const values = new Set(recorded);
  for (const value of implicit) {
    values.add(value);
  }
  // This identity survives a new render becoming complete: the immutable build still selects
  // the shared entry for later manual revalidation, even when that generation needs no resume.
  if (descriptor.kind === 'app-page' && isClassShell(descriptor.pathname, descriptor.route)) {
    values.add(sharedShellTagOf(entryId));
  }
  return values;
}
