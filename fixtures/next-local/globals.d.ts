/** How often the instrumentation hook ran: set by `register()`, read back by a route. */
// eslint-disable-next-line no-var -- a `var` is what augments `globalThis`
declare var fixtureInstrumented: number | undefined;

/** The fixture's "database" (`lib/db.ts`), shared by every module graph of the isolate. */
// eslint-disable-next-line no-var -- a `var` is what augments `globalThis`
declare var fixtureDb: { version: number; renders: number } | undefined;

/**
 * `import wasm from './x.wasm?module'` is the form Vercel's edge runtime documents for
 * WebAssembly that cannot be compiled at run time, and Turbopack resolves it; TypeScript needs to
 * be told what it is.
 */
declare module '*.wasm?module' {
  const module: WebAssembly.Module;

  export default module;
}

/** Without `?module` the loader instantiates the module and re-exports what it exports. */
declare module '*.wasm' {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- the name the module exports
  export function add_one(n: number): number;
}
