// The other form Turbopack builds: without `?module` the loader instantiates the module for you
// and re-exports its exports, so the two helpers Turbopack bundles (`compileModule` and
// `instantiate`) are both exercised by this fixture.
import { add_one } from './add.wasm';

export function incrementEagerly(n: number): number {
  return add_one(n);
}
