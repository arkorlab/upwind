import type { ImageRequestParams } from '@stayingupwind/core/images';

/**
 * What the Function makes of an image it serves itself (`image-fallback.ts`) beyond looking at it:
 * on Workers, nothing. The edge in front of it resizes and re-encodes an image with the Images
 * service, and answers a client that holds it already with a 304 (`handlers/image.ts` in the edge);
 * the Function's own answer — the fallback for when the edge has no manifest to optimize from — is
 * the source as it is, and it has no encoder to make another. A target with no edge in front of it
 * does both, by the edge's rules (`native/image-encoder.ts`, which the build swaps in for this one).
 */

export interface EncodeImageInput {
  /** The source, read whole. */
  readonly bytes: Uint8Array;
  /** Its type, from its bytes (`detectImageType`): one the optimizer transforms, not one it passes on. */
  readonly upstreamType: string;
  readonly params: ImageRequestParams;
}

export type EncodedImage =
  /** The source resized and re-encoded, as `contentType`. */
  | { readonly kind: 'encoded'; readonly bytes: Uint8Array; readonly contentType: string }
  /** To go out as it is, as the optimizer passes on an animation. */
  | { readonly kind: 'as-is' }
  /** The encoder failed: the source stands in, for the shortest lifetime the configuration allows. */
  | { readonly kind: 'failed' };

/**
 * The source resized and re-encoded for the request, or `undefined` where there is no encoder to
 * do it. Synchronous where it says so, so a caller waits on nothing then.
 */
export type ImageEncoder = (input: EncodeImageInput) => Promise<EncodedImage> | undefined;

/** Whether the client already holds the image the answer carries, by the entity tag it carries. */
export type ImageValidator = (request: Request, etag: string | undefined) => boolean;

export const encodeImage: ImageEncoder = () => {
  // Here, none: there is no encoder, and the source goes out as it is.
};

/** Here, never asked: the edge in front answers a client that holds the image. */
export const holdsImage: ImageValidator = () => false;
