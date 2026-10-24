import { cacheLife, cacheTag } from 'next/cache';
import type { ReactNode } from 'react';

import { readForRender } from '../../../lib/db';

type Params = Promise<{ readonly slug: string }>;

// Longer than anything that asks it waits (`probe.mts`): a new version is then one a revalidation
// asked for, never one the lifetime ran out into.
const REVALIDATE_SECONDS = 86_400;
const EXPIRE_SECONDS = 604_800;

/** One member the build knows; any other is rendered on demand and kept by the cache. */
export function generateStaticParams(): { slug: string }[] {
  return [{ slug: 'first' }];
}

/**
 * Cached whole, under the tags a revalidation names: what a regeneration publishes is a render
 * of this, and what an invalidation of `posts` throws away is the value it read.
 */
export default async function PostPage({
  params,
}: {
  readonly params: Params;
}): Promise<ReactNode> {
  'use cache';
  const { slug } = await params;
  cacheLife({ revalidate: REVALIDATE_SECONDS, expire: EXPIRE_SECONDS });
  cacheTag('posts', `post:${slug}`);
  const snapshot = readForRender();
  return (
    <main>
      <h1 id="shell">fixture post</h1>
      <p id="post">{`post=${slug} v=${snapshot.version} r=${snapshot.renders}`}</p>
    </main>
  );
}
