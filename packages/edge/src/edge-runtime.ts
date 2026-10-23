import type { EdgeMemory } from './memory/caches.ts';
import type { RouteReports } from './reports.ts';

export type FetchImpl = (request: Request, init?: RequestInit) => Promise<Response>;

/**
 * What a dispatched Function may spend, where the way the host reaches it can bound it; absent, its
 * own defaults apply. A host that reaches its Functions by a service binding has no such bound, and
 * sets them on the Function instead.
 */
interface DispatchLimits {
  readonly cpuMs: number;
  readonly subRequests: number;
}

/**
 * Invoke one of the deployment's Functions by the name the pointer gives it: an app Function, or
 * the small one holding only the middleware. The request goes to it as it is; the Function is the
 * origin. How a name is reached is the host's.
 */
export type DispatchApp = (
  scriptName: string,
  request: Request,
  limits?: DispatchLimits,
) => Promise<Response>;

/** What the Images service is asked for: one resize, one encoding. */
export interface ImageTransformRequest {
  readonly width: number;
  readonly format: 'image/avif' | 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
  readonly quality: number;
}

interface ImageTransformResult {
  /** The type actually produced: AVIF is best-effort and may come back as WebP. */
  readonly contentType: string;
  readonly body: ReadableStream<Uint8Array>;
}

export type TransformImage = (
  source: ReadableStream<Uint8Array>,
  request: ImageTransformRequest,
) => Promise<ImageTransformResult>;

export function transformMode(transform: TransformImage | undefined): string {
  return transform === undefined ? 'original' : 'transform';
}

/**
 * Ask the host's blob reader for an object of the bucket by its content address — `/<sha256>`, or
 * `/manifests/<sha256>` — and the request's headers and signal: a reader that answers through a
 * tiered cache, where the host has one. Where it is the reader is the host's.
 */
export type BlobWorker = (path: string, init: RequestInit) => Promise<Response>;

/** What the edge reaches out with on a request; tests replace fetch, time, dispatch and the rest. */
export interface EdgeRuntime {
  readonly fetchImpl: FetchImpl;
  readonly now: () => number;
  readonly memory: EdgeMemory;
  /**
   * The deployment's Functions; `undefined` where the host has none to reach, and every request
   * that would go to one is answered `502` instead.
   */
  readonly dispatchApp: DispatchApp | undefined;
  /** The Images binding; `undefined` where none is bound, and sources then go out as they are. */
  readonly transformImage: TransformImage | undefined;
  /**
   * The host's blob reader; `undefined` where it has none, and the bucket is then read directly, as
   * it is whenever this answers with anything but the bytes asked for.
   */
  readonly blobWorker: BlobWorker | undefined;
  /** Where the edge's reports of a route go; `undefined` sends none (`RouteReports`). */
  readonly reports?: RouteReports | undefined;
}

/**
 * The Images binding as a plain function: the whole source in, one resized encoding out. Frames
 * of an animation are kept (`anim`), which the service resizes one by one, and nothing is
 * upscaled (`scale-down`), as Next.js never enlarges a source either.
 */
export function imagesTransform(images: ImagesBinding | undefined): TransformImage | undefined {
  if (images === undefined) {
    return undefined;
  }
  return async (source, request): Promise<ImageTransformResult> => {
    const result = await images
      .input(source)
      .transform({ width: request.width, fit: 'scale-down' })
      .output({ format: request.format, quality: request.quality, anim: true });
    return { contentType: result.contentType(), body: result.image() };
  };
}
