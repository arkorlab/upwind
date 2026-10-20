const PRIVATE_HEADERS = [
  'authorization',
  'cookie',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  'proxy-authorization',
];

/** Version 1 admits no query, visitor state or conditional representation of static Pages HTML. */
export function staticPageRequestPrivate(url: URL, headers: Headers): boolean {
  return url.search !== '' || PRIVATE_HEADERS.some((name) => headers.has(name));
}
