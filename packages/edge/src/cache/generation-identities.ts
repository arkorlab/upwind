import type { DecodedGenerationPack } from '@stayingupwind/core/cache';
import { CACHE_ENTRY_HEADER, SERVED_GENERATION_HEADER } from '@stayingupwind/core/paas';

import { transportableHeaderValue } from '../header-values.ts';

/** Both IDs become header values; the served-generation value also appends a timestamp. */
export function transportableIds(pack: DecodedGenerationPack): boolean {
  if (
    !transportableHeaderValue(pack.header.entryId) ||
    !transportableHeaderValue(pack.header.generationId)
  )
    return false;
  try {
    const headers = new Headers();
    headers.set(CACHE_ENTRY_HEADER, pack.header.entryId);
    headers.set(SERVED_GENERATION_HEADER, `${pack.header.generationId};at=0`);
    return true;
  } catch {
    return false;
  }
}
