import path from 'node:path';

import { rolldown } from 'rolldown';

/**
 * A Worker a suite writes inline, and how it is bundled: as one ES module for a browser target at
 * ES2024, in memory. Only these settings are taken, so a suite names each as it means it.
 */
export interface InlineWorkerBuild {
  /** The Worker's source, read as a module named `sourcefile` in `resolveDir` would be. */
  readonly stdin: {
    readonly contents: string;
    readonly sourcefile: string;
    readonly resolveDir: string;
  };
  readonly bundle: true;
  readonly write: false;
  readonly format: 'esm';
  readonly platform: 'browser';
  readonly target: 'es2024';
  /** What workerd provides itself, left as imports: a name, or a prefix ending in `*`. */
  readonly external?: readonly string[];
  /** Identifiers the source names, replaced with these expressions before it is bundled. */
  readonly define?: Readonly<Record<string, string>>;
}

/** The bundle, in the shape the suites read it in. */
export interface InlineWorkerOutput {
  readonly outputFiles: readonly { readonly text: string }[];
}

/** Whether `id` is one of `external`: a name, or a prefix ending in `*`, as esbuild reads them. */
function isExternal(external: readonly string[], id: string): boolean {
  return external.some((name) =>
    name.endsWith('*') ? id.startsWith(name.slice(0, -1)) : id === name,
  );
}

/**
 * Bundle a suite's inline Worker and everything it imports into one ES module workerd runs.
 *
 * Nothing is tree-shaken: a call the bundler takes for pure, though it throws, would otherwise be
 * dropped from what the Worker runs, and that is what several of these Workers test. An import
 * left unresolved fails the bundle rather than reaching workerd as one it cannot load.
 */
export async function bundleInlineWorker(build: InlineWorkerBuild): Promise<InlineWorkerOutput> {
  const id = path.join(build.stdin.resolveDir, build.stdin.sourcefile);
  await using bundle = await rolldown({
    cwd: build.stdin.resolveDir,
    input: id,
    platform: build.platform,
    treeshake: false,
    transform: {
      target: build.target,
      ...(build.define !== undefined && { define: { ...build.define } }),
    },
    external: (source) => isExternal(build.external ?? [], source),
    plugins: [
      {
        name: 'inline-worker',
        resolveId: (source) => (source === id ? id : undefined),
        load: (file) => (file === id ? build.stdin.contents : undefined),
      },
    ],
    onLog(level, log, defaultHandler) {
      defaultHandler(log.code === 'UNRESOLVED_IMPORT' ? 'error' : level, log);
    },
  });
  const { output } = await bundle.generate({ format: build.format, codeSplitting: false });
  const [chunk, ...rest] = output;
  if (rest.length > 0) {
    throw new Error(`Rolldown did not produce one ES module for ${build.stdin.sourcefile}`);
  }
  return { outputFiles: [{ text: chunk.code }] };
}
