import type { Prerender } from '@stayingupwind/core/bundle';
import { parseCacheTagsHeader } from '@stayingupwind/core/cache';
import {
  parseResumePublicationHeader,
  PUBLICATION_RESUME_HEADER,
  resumePublicationHeader,
} from '@stayingupwind/core/paas';

import { nowMs } from './cache/clock.ts';
import { observeFreshPublication } from './cache/publication.ts';
import { requirePublication } from './publication.ts';
import type { RoutedInput } from './serve.ts';

function buildTags(initial: Prerender['initialHeaders']): string[] {
  if (initial === undefined) return [];
  const headers = new Headers();
  for (const [name, value] of Object.entries(initial)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) headers.append(name, item);
  }
  return parseCacheTagsHeader(headers.get('x-next-cache-tags') ?? undefined);
}

/** A suffix retains the selected shell's original grants without requiring another data read. */
export function observeResumePublication(
  input: RoutedInput,
  route: string,
  headers?: Prerender['initialHeaders'],
): void {
  requirePublication(input.cache, route);
  const selected = parseResumePublicationHeader(
    input.request.headers.get(PUBLICATION_RESUME_HEADER),
  );
  const built = buildTags(headers);
  const encoded = resumePublicationHeader(built);
  observeFreshPublication([...selected, ...parseResumePublicationHeader(encoded ?? null)], nowMs());
}
