import type { ImageRequestParams, ImagesConfig } from '@stayingupwind/core/images';

/**
 * What the Function keeps of the images it makes itself (`image-fallback.ts`): on Workers, nothing.
 * The edge in front of it keeps every image it optimizes in the Cache API (`handlers/image.ts` and
 * `handlers/image-cache.ts` in the edge), and the Function's own answer — the fallback for when the
 * edge has no manifest to optimize from — is the source as it is, nothing it would make twice. A
 * target with no edge in front of it keeps what it makes by the edge's rules
 * (`native/image-cache.ts`, which the build swaps in for this one).
 */

/** The request for an image, as what it is kept under is read off it. */
export interface ImageCacheInput {
  /** The client's request: a hit is answered to it as a fresh image would be — HEAD, a validator. */
  readonly request: Request;
  readonly params: ImageRequestParams;
  readonly images: ImagesConfig;
  /** The deployment the application's own paths answer for: an image of one of them is its own. */
  readonly deploymentId: string;
  /** A middleware had a say on the request: what it let one visitor have is kept for no other. */
  readonly middlewareRan: boolean;
  /** Where writing an image down is waited on, so a server that stops lets it land. */
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

/** An image made for a request, as it is kept and a hit is answered from. */
export interface KeptImage {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly etag: string;
  /** Seconds a client may keep it, which it is kept for too. */
  readonly maxAge: number;
  /** The source stood in for a transformation that failed: kept for that lifetime alone, as it went. */
  readonly fallback: boolean;
}

/** Where the request's image is kept: the answer it gives, or a way to keep the one about to be made. */
export interface ImageCacheSlot {
  /** The answer the image kept for the request gives, where one is kept. */
  readonly hit: Response | undefined;
  /** Keep the image made for the request, where it may be kept; never throws, never waits. */
  readonly keep: ((image: KeptImage) => void) | undefined;
}

/** The request's slot, or `undefined` where nothing is kept: synchronously then, waiting on nothing. */
export type ImageCacheOpener = (input: ImageCacheInput) => Promise<ImageCacheSlot> | undefined;

export const openImageCache: ImageCacheOpener = () => {
  // Here, nothing is kept: the edge keeps what it optimizes.
};
