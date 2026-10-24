// `?module` asks Turbopack for the compiled `WebAssembly.Module` rather than an instantiated one,
// which is the only form that works where WebAssembly cannot be compiled at run time — Next.js's
// edge runtime, and a Cloudflare Worker. The module is instantiated once, at module scope, and
// every request awaits the same promise.
import wasm from './add.wasm?module';

const instance = WebAssembly.instantiate(wasm);

export async function increment(n: number): Promise<number> {
  const { exports } = await instance;
  // eslint-disable-next-line @typescript-eslint/naming-convention -- the name the module exports
  const { add_one } = exports as { add_one: (n: number) => number };
  return add_one(n);
}
