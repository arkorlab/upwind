/**
 * Next's source and the server modules its bundlers emit. Match server directories rather than
 * `.next`, because a project may set distDir. Installed adapter/CLI bundles contain the source
 * transforms themselves; their marker strings must never be mistaken for Next's implementation.
 */
export function isNextRuntimeModule(url: string): boolean {
  return (
    url.startsWith('file:') &&
    url.endsWith('.js') &&
    (url.includes('/next/dist/') || /\/server\/(?:chunks|app|pages)\//u.test(url))
  );
}
