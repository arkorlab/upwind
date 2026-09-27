import add from '../../wasm/add.wasm?module';

// An entrypoint on the deprecated edge runtime. Its chunks are evaluated by `edge.cjs`, and the
// handler is read back from `globalThis._ENTRIES[entryKey]` — the documented way to invoke one.
export const runtime = 'edge';

export async function GET() {
  const instance = await WebAssembly.instantiate(add, {});
  return Response.json({ sum: instance.exports.add(1, 2) });
}
