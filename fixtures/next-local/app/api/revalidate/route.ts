import { revalidatePath, revalidateTag } from 'next/cache';
import type { NextRequest } from 'next/server';

import { bump } from '../../../lib/db';

/**
 * Bumps the fixture's database, then invalidates what the query names: a tag, at once
 * (`mode=now`) or with the window `revalidateTag`'s `max` profile gives it, or a path.
 */
export function POST(request: NextRequest): Response {
  const query = request.nextUrl.searchParams;
  const version = bump();
  const tag = query.get('tag');
  if (tag !== null) {
    revalidateTag(tag, query.get('mode') === 'now' ? { expire: 0 } : 'max');
  }
  const path = query.get('path');
  if (path !== null) {
    revalidatePath(path);
  }
  return Response.json({ version, tag, path });
}
