import { connection } from 'next/server';

// Both forms Turbopack compiles a `.wasm` import into on the Node.js runtime: `?module` gives a
// module to compile, the plain import gives an instance's exports. The `wasm-loader` patch turns
// the loader's file read into a read of the module the Function carries.
import compiled from '../../../wasm/add.wasm?module';
import { add } from '../../../wasm/add.wasm';

export async function GET() {
  await connection();
  const instance = await WebAssembly.instantiate(compiled, {});
  return Response.json({ compiled: instance.exports.add(1, 2), instantiated: add(3, 4) });
}
