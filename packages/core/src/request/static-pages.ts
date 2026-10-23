import { NEXT_DATA_HEADER, ROUTER_PROTOCOL_HEADERS } from './constants.ts';

export const STATIC_PAGE_PRIVATE_HEADERS: readonly string[] = [
  'authorization',
  'cookie',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  'proxy-authorization',
  'x-matched-path',
  'x-next-revalidate-tag-token',
  'x-next-revalidated-tags',
];

/** Version 1 admits no query, visitor state or conditional representation of static Pages HTML. */
export function staticPageRequestPrivate(url: URL, headers: Headers, pagesData = false): boolean {
  return (
    url.search !== '' ||
    STATIC_PAGE_PRIVATE_HEADERS.some((name) => headers.has(name)) ||
    [...ROUTER_PROTOCOL_HEADERS, NEXT_DATA_HEADER].some(
      (name) => (!pagesData || name !== NEXT_DATA_HEADER) && headers.has(name),
    )
  );
}
