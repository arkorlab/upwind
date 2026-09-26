// The hook exists so that the `instrumentation` patch has a file to resolve the computed
// `require` to. A build without one takes the patch's other branch, an empty module.
export function register() {
  globalThis.__upwindFixtureRegistered = true;
}
