declare module 'arkor:native-function' {
  const entry: {
    fetch(
      request: Request,
      env: unknown,
      ctx: { waitUntil(promise: Promise<unknown>): void },
    ): Promise<Response>;
  };
  export function closeNodeBridge(timeoutMs?: number): Promise<boolean>;
  /** Where the server keeps the images it makes (`runtime/src/native/image-cache.ts`). */
  export function configureImageCache(
    options: { readonly directory: string; readonly maxBytes?: number | undefined } | undefined,
  ): void;
  export default entry;
}
