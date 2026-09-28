import path from 'node:path';

import { jsLiteral } from '../codegen.ts';
import { type Patch, Rewrite } from './types.ts';

/**
 * `instrumentation-globals.external.js` finds the instrumentation hook with a `require` of a path
 * it computes from the project and dist directories. The hook is one known file, or there is
 * none: the `require` names that file, so the bundler bundles it, or yields an empty module —
 * what Next.js makes of a hook file that is not there, without the module-not-found error it
 * would have caught on the way.
 */

const NAME = 'instrumentation';
/** Next.js's CommonJS build, for the reason `load-manifest.ts` gives of its own target. */
const TARGET = /\/next\/dist\/server\/lib\/router-utils\/instrumentation-globals\.external\.js$/u;
const HOOK_REQUIRE =
  /await require\(_nodepath\.default\.join\(projectDir, distDir, 'server', `\$\{_constants\.INSTRUMENTATION_HOOK_FILENAME\}\.js`\)\)/gu;
const LEFTOVERS = [/INSTRUMENTATION_HOOK_FILENAME\}\.js`\)\)/u];

export const instrumentationPatch: Patch = {
  name: NAME,
  target: TARGET,
  // One file of Next.js's own, and no copy of it anywhere else.
  reaches: ['module'],
  apply(source, file, ctx) {
    const replacement =
      ctx.instrumentation === undefined
        ? 'await ({})'
        : `await require(${jsLiteral(ctx.instrumentation)})`;
    const result = new Rewrite(NAME, file, source)
      .replace(HOOK_REQUIRE, replacement, 1, 'the hook loader')
      .forbid(LEFTOVERS, 'a computed hook require');
    return {
      contents: result.contents,
      edits: result.edits,
      notes: [
        ctx.instrumentation === undefined
          ? 'no hook'
          : `hook: ${path.relative(ctx.distDir, ctx.instrumentation).split(path.sep).join('/')}`,
      ],
    };
  },
};
