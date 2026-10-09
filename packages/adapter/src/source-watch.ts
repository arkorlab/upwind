import path from 'node:path';

import type { Plugin } from 'esbuild';

const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.css', '.json'];

/** Capture dependency versions before esbuild reads them, including files discovered by imports. */
export function watchBuildSources(beforeRead: (file: string) => void): Plugin {
  return {
    name: 'upwind-source-watch',
    setup(builder) {
      // eslint-disable-next-line require-unicode-regexp -- esbuild filters are Go regular expressions.
      builder.onResolve({ filter: /.*/, namespace: 'file' }, (args): undefined => {
        const specifier = args.path.replace(/\?module$/u, '');
        if (
          !path.isAbsolute(specifier) &&
          specifier !== '.' &&
          specifier !== '..' &&
          !specifier.startsWith('./') &&
          !specifier.startsWith('../')
        )
          return;
        const target = path.resolve(args.resolveDir, specifier);
        const extensions = builder.initialOptions.resolveExtensions ?? RESOLVE_EXTENSIONS;
        beforeRead(target);
        if (path.extname(target) === '') {
          for (const extension of extensions) {
            beforeRead(`${target}${extension}`);
            beforeRead(path.join(target, `index${extension}`));
          }
          beforeRead(path.join(target, 'package.json'));
        }
      });
      // eslint-disable-next-line require-unicode-regexp -- esbuild filters are Go regular expressions.
      builder.onLoad({ filter: /.*/, namespace: 'file' }, (args): undefined => {
        beforeRead(args.path);
      });
    },
  };
}
