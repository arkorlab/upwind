import { type OutputChunk, rolldown } from 'rolldown';

import { jsLiteral } from './codegen.ts';
import { generatedModulesPlugin } from './generated-modules.ts';
import { manglerGetsWrong } from './mangle-packages.ts';
import { GLOBAL_OBJECT, globalObjectPlugin, THROWING_GLOBALS } from './throwing-globals.ts';

/** What the runtime module of one Function is bundled from, and as. */
export interface RuntimeBundleInput {
  /** The runtime's own entry (`@stayingupwind/runtime/function`). */
  readonly entry: string;
  readonly outFile: string;
  /** The module's name in the Function, which `__filename` says. */
  readonly moduleName: string;
  readonly kind: string;
  /** The Function's own name, which a request for another Function's route is told apart by. */
  readonly name: string;
  readonly workflowSdk: boolean;
  /** The names this Function's code is uploaded under (`codeModules`). */
  readonly modules: { readonly app: string; readonly edge: string };
  readonly edge: boolean;
  readonly wasm: boolean;
  readonly cacheHostModule: string | undefined;
  readonly requireBundleBlobReader?: boolean | undefined;
}

/**
 * The Function's runtime module: the runtime's source and the cache host it names, bundled by
 * Rolldown into one ES module beside `app.cjs`, for the `workerd` and `worker` conditions.
 *
 * Rolldown shakes what esbuild could not: the members of a namespace object a dependency builds,
 * which kept the whole of a schema library in the runtime where a cache host imported it by name.
 * For the same files its bundle is smaller as well.
 */
export async function bundleRuntimeModule(input: RuntimeBundleInput): Promise<void> {
  const unresolved: string[] = [];
  await using bundle = await rolldown({
    input: input.entry,
    platform: 'node',
    // esbuild's conditions for the platform, with `workerd` and `worker` added. Rolldown adds `import`
    // or `require` to them by how a module is imported, as esbuild does: a `require` of a package
    // gets what the package exports to `require`, and not what it exports to `import`. Neither is
    // listed here for that reason: listed, `import` matched a `require` too. (Checked on a package
    // that exports nothing but `import`, `require` and `default`: each kind got its own.)
    resolve: { conditionNames: ['workerd', 'worker', 'node', 'default'] },
    external: [/^node:/u, /^cloudflare:/u],
    plugins: [
      globalObjectPlugin(),
      generatedModulesPlugin({
        modules: input.modules,
        edge: input.edge,
        wasm: input.wasm,
        cacheHostModule: input.cacheHostModule,
        requireBundleBlobReader: input.requireBundleBlobReader,
      }),
    ],
    transform: {
      target: 'es2024',
      inject: GLOBAL_OBJECT,
      define: {
        ...THROWING_GLOBALS,
        'process.env.NODE_ENV': '"production"',
        __ARKOR_FUNCTION_KIND__: jsLiteral(input.kind),
        __ARKOR_BUNDLE_ROOT__: '"/bundle"',
        // Which Function this is, among a deployment's app Functions: what a request for a route of
        // another one is told apart by (`placement.ts`).
        __ARKOR_FUNCTION_NAME__: jsLiteral(input.name),
        // A build without the Workflow SDK leaves the runtime's part for it out entirely.
        __ARKOR_WORKFLOW_SDK__: jsLiteral(input.workflowSdk),
        // CommonJS conveniences that `@next/routing`'s build references at module scope.
        __dirname: '"/bundle"',
        __filename: jsLiteral(`/bundle/${input.moduleName}`),
      },
    },
    onLog(_level, log) {
      // A module the bundler cannot find is one the Function would not have either; anything else
      // it says (the stub cache host's missing blob reader among it) stays with the build. Of a
      // `require()` inside a `try` block, or an `import()` awaited inside one, Rolldown says
      // nothing: the call is left to fail at run time, for the module's own fallback to catch, as
      // esbuild left it.
      if (log.code === 'UNRESOLVED_IMPORT') {
        unresolved.push(log.message);
      }
    },
  });
  // The runtime carries code this package did not write — the cache host a host names, and the
  // packages both import — and the mangler has open bugs that rename some code wrongly
  // (`manglerGetsWrong`). The bundle is rendered once, as the minifier would be handed it, and read
  // for them: one that has any is minified without renaming.
  const { output } = await bundle.generate({ format: 'esm', codeSplitting: false });
  // Read once the bundle is generated: Rolldown reads the modules then, and not before, so what it
  // could not resolve is said then too. Nothing has been written yet.
  if (unresolved.length > 0) {
    throw new Error(
      `@stayingupwind/adapter: the runtime imports what it cannot resolve\n${unresolved.join('\n')}`,
    );
  }
  const rendered = output.find((item): item is OutputChunk => item.type === 'chunk');
  const renaming = rendered !== undefined && !manglerGetsWrong(input.outFile, rendered.code);
  await bundle.write({
    file: input.outFile,
    format: 'esm',
    codeSplitting: false,
    // Whitespace and syntax, as `app.cjs` is minified, and the names of variables and parameters,
    // the module's top level among them: an ES module's top level is its own, and what it exports
    // keeps the name it is exported by. The names of functions and classes are kept
    // (`keepNames`), so a stack trace out of the runtime still says which function it came from,
    // wherever it is read — an error reporter in the Worker reads it as V8 wrote it, with no map
    // to read it back through. On a fixture's app Function that took the runtime from 360,851 to
    // 273,664 bytes and the middleware Function's from 132,926 to 103,041, with every function and
    // class in them named as before; mangled as well, those names would have taken off another
    // 33,316 and 12,784 bytes, and left every frame of the runtime's named by a letter or two.
    minify: {
      compress: true,
      mangle: renaming && { toplevel: true, keepNames: true },
      codegen: { removeWhitespace: true },
    },
    comments: { legal: false },
    sourcemap: false,
  });
}
