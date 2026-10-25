declare module 'arkor:native-function' {
  const entry: {
    fetch(
      request: Request,
      env: unknown,
      ctx: { waitUntil(promise: Promise<unknown>): void },
    ): Promise<Response>;
  };
  export function closeNodeBridge(timeoutMs?: number): Promise<boolean>;
  export default entry;
}
