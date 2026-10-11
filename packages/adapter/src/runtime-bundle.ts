import { rolldown } from 'rolldown';

import { jsLiteral } from './codegen.ts';
import { generatedModulesPlugin } from './generated-modules.ts';
import { THROWING_GLOBALS } from './throwing-globals.ts';

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
    // gets what the package exports to `require`, and not what it exports to `import`.
    resolve: { conditionNames: ['workerd', 'worker', 'node', 'default'] },
    external: [/^node:/u, /^cloudflare:/u],
    plugins: [
      generatedModulesPlugin({
        modules: input.modules,
        edge: input.edge,
        wasm: input.wasm,
        cacheHostModule: input.cacheHostModule,
      }),
    ],
    transform: {
      target: 'es2024',
      define: {
        ...THROWING_GLOBALS,
        'process.env.NODE_ENV': '"production"',
        __ARKOR_FUNCTION_KIND__: jsLiteral(input.kind),
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
      // `require()` or an `import()` inside a `try` block Rolldown says nothing: the call is left
      // to throw at run time, for the module's own fallback to catch, as esbuild left it.
      if (log.code === 'UNRESOLVED_IMPORT') {
        unresolved.push(log.message);
      }
    },
  });
  if (unresolved.length > 0) {
    throw new Error(
      `@stayingupwind/adapter: the runtime imports what it cannot resolve\n${unresolved.join('\n')}`,
    );
  }
  await bundle.write({
    file: input.outFile,
    format: 'esm',
    codeSplitting: false,
    // Whitespace and syntax, as `app.cjs` is minified, and not names: a stack trace out of the
    // runtime still says which function it came from.
    minify: { compress: true, mangle: false, codegen: { removeWhitespace: true } },
    comments: { legal: false },
    sourcemap: false,
  });
}
