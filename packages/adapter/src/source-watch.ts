import type { Plugin } from 'esbuild';

/** Capture dependency versions before esbuild reads them, including files discovered by imports. */
export function watchBuildSources(beforeRead: (file: string) => void): Plugin {
  return {
    name: 'upwind-source-watch',
    setup(builder) {
      // eslint-disable-next-line require-unicode-regexp -- esbuild filters are Go regular expressions.
      builder.onLoad({ filter: /.*/, namespace: 'file' }, (args): undefined => {
        beforeRead(args.path);
      });
    },
  };
}
