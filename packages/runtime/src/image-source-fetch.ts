export type ImageSourceFetcher = (
  target: URL,
  signal: AbortSignal,
  dangerouslyAllowLocalIP: boolean,
) => Promise<Response>;

/** Workers use the platform transport. Native builds replace this module, not the global fetch. */
export const fetchImageSource: ImageSourceFetcher = (target, signal) =>
  fetch(target.href, { redirect: 'manual', signal });
