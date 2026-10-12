import path from 'node:path';

import { jsLiteral } from '../codegen.ts';
import { type Patch, Rewrite } from './types.ts';

/**
 * Next.js's route modules load a cache handler the application configured with a dynamic
 * `import()` of a file: `interopDefault(await dynamicImportEsmDefault(formatDynamicImportPath(dir,
 * handler)))`, once for the `cacheHandler` as the incremental cache is made, and once for each of
 * `cacheHandlers` as they are registered (`route-module.ts`). A Function has no file to import, so
 * both become a `require` of the module the build wrote (`writeCacheHandlers`), which answers the
 * path Next.js recorded with the handler bundled for it.
 *
 * A build that configured none gets an answer that says so in their place, where Next.js never
 * asks: it registers no handler for a kind whose path is empty, and makes the incremental cache
 * without one. Rewritten either way, so that a release that moved either import fails every build
 * the same, rather than only the one that configures a handler.
 */

const NAME = 'cache-handlers';
/** The route runtimes a Node.js entry loads; the edge runtime loads no custom handler. */
const TARGET =
  // eslint-disable-next-line require-unicode-regexp -- a bundler filter: a Go regular expression
  /next-server\/(?:app-page|app-route|pages|pages-api)(?:-turbo)?(?:-experimental)?\.runtime\.prod\.js$/;
/** Each of `cacheHandlers`, imported from under the project's output directory. */
const HANDLERS_IMPORT =
  // eslint-disable-next-line sonarjs/super-linear-regex -- run once per build over a file of Next.js's, never over anything a request carries
  /(?<interop>\w+)\(await \w+\(\w+\(`\$\{\w+\}\/\$\{this\.distDir\}`,(?<value>\w+)\)\)\)/gu;
/** The `cacheHandler`, imported from under the output directory. */
// eslint-disable-next-line sonarjs/super-linear-regex -- as above
const HANDLER_IMPORT = /(?<interop>\w+)\(await \w+\(\w+\(this\.distDir,(?<value>\w+)\)\)\)/gu;
// eslint-disable-next-line sonarjs/super-linear-regex -- as above
const LEFTOVERS = [/\$\{this\.distDir\}`,\w+\)/u, /\w+\(this\.distDir,\w+\)\)\)/u];

/** `text` for an `expand` template: a `$` of its own stands for itself rather than for a group. */
function templated(text: string): string {
  return text.replaceAll('$', '$$$$');
}

/** What loads the handler `$<value>` names: the build's module, or an answer that there is none. */
function loading(module: string | undefined): string {
  if (module === undefined) {
    const message = jsLiteral('@stayingupwind/adapter: this build configured no cache handler at ');
    return `$<interop>(await Promise.reject(new Error(${templated(message)}+$<value>)))`;
  }
  return `$<interop>(await require(${templated(jsLiteral(module))}).load($<value>))`;
}

export const cacheHandlersPatch: Patch = {
  name: NAME,
  target: TARGET,
  // The compiled route runtimes, which are the only place `TARGET` names.
  reaches: ['server-runtime'],
  apply(source, file, ctx) {
    const replacement = loading(ctx.cacheHandlers);
    const result = new Rewrite(NAME, file, source)
      .expand(HANDLERS_IMPORT, replacement, 1, 'the cacheHandlers import')
      .expand(HANDLER_IMPORT, replacement, 1, 'the cacheHandler import')
      .forbid(LEFTOVERS, 'an import of a cache handler by path');
    return {
      contents: result.contents,
      edits: result.edits,
      notes: [
        ctx.cacheHandlers === undefined
          ? 'no handler'
          : `handlers: ${path.relative(ctx.distDir, ctx.cacheHandlers).split(path.sep).join('/')}`,
      ],
    };
  },
};
