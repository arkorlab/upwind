import { type Prerender, standsForClass } from '@stayingupwind/core/bundle';
import {
  appPathFor,
  type GenerationTag,
  implicitTagsFor,
  parseCacheTagsHeader,
  type RouteEntryDescriptor,
  sharedShellTagOf,
  tagKindOf,
} from '@stayingupwind/core/cache';

import { isClassShell } from '../store.ts';
import type { CapturedRender } from './capture.ts';
import { RegenerationError } from './lease.ts';
import { refusedTags } from './tag-bounds.ts';

/** Use the selected build's classification only when it describes this exact entry. */
export function generationClassShell(
  descriptor: RouteEntryDescriptor,
  shell: Prerender | undefined,
): boolean {
  return shell?.route === descriptor.route && shell.pathname === descriptor.pathname
    ? standsForClass(shell)
    : isClassShell(descriptor.pathname, descriptor.route);
}

/** The render's tags and the implicit identities under which its entry can be invalidated. */
export function generationTagValues(
  descriptor: RouteEntryDescriptor,
  render: CapturedRender,
  entryId: string,
  isClass = descriptor.kind !== 'pages' && isClassShell(descriptor.pathname, descriptor.route),
): Set<string> {
  const recorded = parseCacheTagsHeader(render.headers['x-next-cache-tags']);
  const concrete = isClass ? undefined : descriptor.pathname;
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
  if (isClass && descriptor.kind === 'app-page') {
    values.add(sharedShellTagOf(entryId));
  }
  return values;
}

/** Refuse the render's tags before uploading, keeping the pathname and refusal code on its attempt. */
export function generationTags(
  descriptor: RouteEntryDescriptor,
  render: CapturedRender,
  entryId: string,
  isClass: boolean | undefined,
): GenerationTag[] {
  const values = [...generationTagValues(descriptor, render, entryId, isClass)];
  const refused = refusedTags(values);
  if (refused !== undefined) {
    throw new RegenerationError(`the render of ${descriptor.pathname} ${refused.message}`, {
      code: refused.code,
    });
  }
  return values.map((value) => ({ kind: tagKindOf(value), value }));
}
