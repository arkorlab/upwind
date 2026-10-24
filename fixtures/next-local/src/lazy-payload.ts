// Top-level await makes this an async module, so requiring it hands back a promise — which is
// the only thing Next.js's `trackPendingImport` tracks (`if (exportsOrPromise instanceof Promise)`).
// A library that instantiates WebAssembly or opens a connection at module scope looks like this.
const ready = await Promise.resolve('a module loaded on demand');

export const payload = { from: ready };
