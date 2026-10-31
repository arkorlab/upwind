import { parseCacheTagsHeader } from '@stayingupwind/core/cache';
import {
  observePublicationTags,
  parseResumePublicationHeader,
  PUBLICATION_RESUME_HEADER,
  resumePublicationHeader,
} from '@stayingupwind/core/paas';

import { requirePublication } from './publication.ts';
import type { RoutedInput } from './serve.ts';

/** A suffix retains the selected shell's original grants without requiring another data read. */
export function observeResumePublication(
  input: RoutedInput,
  route: string,
  headers?: Readonly<Record<string, string>>,
): void {
  requirePublication(input.cache, route);
  const selected = parseResumePublicationHeader(
    input.request.headers.get(PUBLICATION_RESUME_HEADER),
  );
  const built = parseCacheTagsHeader(new Headers(headers).get('x-next-cache-tags') ?? undefined);
  const encoded = resumePublicationHeader(built);
  observePublicationTags([...selected, ...parseResumePublicationHeader(encoded ?? null)]);
}
