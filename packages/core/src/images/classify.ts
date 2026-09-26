import type { ProjectManifest } from '../manifest/schema.ts';
import type { ImagesConfig } from './config.ts';

/**
 * Whether a request is one for `/_next/image` of a hosted application whose build left the
 * default loader on. Decided ahead of the general classification, as a shipped file is, and only
 * when the manifest carries an image configuration: a fronted origin's `/_next/image` stays with
 * its origin, which optimizes it itself.
 */

export interface ImageRequestClass {
  readonly kind: 'image';
  readonly images: ImagesConfig;
}

const IMAGE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

function withoutTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

export function classifyImageRequest(input: {
  readonly method: string;
  readonly url: URL;
  readonly manifest: ProjectManifest;
}): ImageRequestClass | undefined {
  const { manifest } = input;
  if (manifest.images === undefined) {
    return undefined;
  }
  if (!IMAGE_METHODS.has(input.method)) {
    return undefined;
  }
  // With `trailingSlash` the loader asks for `/_next/image/`; either spelling is the optimizer's.
  if (withoutTrailingSlash(input.url.pathname) !== withoutTrailingSlash(manifest.images.path)) {
    return undefined;
  }
  return { kind: 'image', images: manifest.images };
}
