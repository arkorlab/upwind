import { readFile } from 'node:fs/promises';
import path from 'node:path';

import * as z from '@stayingupwind/core/schema';

import { withBasePath } from './segments.ts';

/**
 * The routes whose `ensureStatic` is `navigation` (Next.js 16.4), by the pathname their entry is
 * filed under — the template, under the `basePath`.
 *
 * Next.js says so of a route in `prerender-manifest.json` alone (`_isEnsureStaticPage`, on the
 * route's entry in `dynamicRoutes`), and reads it at request time: a request for React Server
 * Components of a member the build did not render is then answered with a blocking render, never a
 * dynamic one (`isDynamicRSCRequest`, in the page's handler). The Adapter API hands over no such
 * field, so it is read where Next.js reads it. A release before 16.4 writes none, and a build with
 * no manifest — a static export — has no such route either.
 */
const dynamicRouteSchema = z.object({ _isEnsureStaticPage: z.boolean().optional() });
const manifestSchema = z.object({ dynamicRoutes: z.record(z.string(), dynamicRouteSchema) });

export async function ensureStaticRoutes(
  distDir: string,
  basePath: string,
): Promise<ReadonlySet<string>> {
  let text: string;
  try {
    text = await readFile(path.join(distDir, 'prerender-manifest.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Set();
    }
    throw error;
  }
  const { dynamicRoutes } = manifestSchema.parse(JSON.parse(text));
  return new Set(
    Object.entries(dynamicRoutes).flatMap(([route, entry]) =>
      entry._isEnsureStaticPage === true ? [withBasePath(basePath, route)] : [],
    ),
  );
}
