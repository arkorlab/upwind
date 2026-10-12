import { type Patch, Rewrite } from './types.ts';

/**
 * `patch-error-inspect.js` maps the frames of an error it prints through the source map it finds for
 * each file, and requires `source-map` at its top to do it: a Function evaluates that library as it
 * starts, before its first answer, whether or not a frame is ever mapped. One is mapped only where a
 * map is found, and the Function carries none of its maps (`sourceMaps` travel beside the bundle,
 * for the host to read; nothing serves them), so the library is evaluated for a constructor that is
 * seldom, if ever, called.
 *
 * The require becomes a read on first use: the one member the module takes from the library,
 * `SourceMapConsumer`, loads it then. What the module does with an error is unchanged, and so is the
 * bundle's content — `source-map` is still bundled, and evaluated the first time a frame is mapped.
 */

const NAME = 'lazy-source-map';
/** Next.js's CommonJS build, for the reason `load-manifest.ts` gives of its own target. */
const TARGET = /\/next\/dist\/server\/patch-error-inspect\.js$/u;
const REQUIRE = 'const _sourcemap = require("next/dist/compiled/source-map");';
/** The one member read off the library, wherever the module reads it. */
const CONSUMER = '_sourcemap.SourceMapConsumer';
/** Any member read off it: a read of another would find the lazy object without it. */
const ANY_MEMBER = /\b_sourcemap\./gu;
const LAZY = [
  'let _sourcemapModule;',
  'const _sourcemap = {',
  '    get SourceMapConsumer () {',
  '        _sourcemapModule ??= require("next/dist/compiled/source-map");',
  '        return _sourcemapModule.SourceMapConsumer;',
  '    }',
  '};',
].join('\n');

export const lazySourceMapPatch: Patch = {
  name: NAME,
  target: TARGET,
  // One file of Next.js's own: the compiled server runtimes require it rather than carry a copy.
  reaches: ['module'],
  apply(source, file) {
    const rewrite = new Rewrite(NAME, file, source);
    const members = [...source.matchAll(ANY_MEMBER)].length;
    const consumers = source.split(CONSUMER).length - 1;
    if (consumers === 0 || members !== consumers) {
      throw rewrite.fail(
        `expected every read of the source-map library to be of ${CONSUMER}, found ${String(consumers)} of ${String(members)}`,
      );
    }
    const result = rewrite.replace(REQUIRE, LAZY, 1, 'the source-map require');
    return {
      contents: result.contents,
      edits: result.edits,
      notes: ['source-map is loaded the first time a frame is mapped'],
    };
  },
};
