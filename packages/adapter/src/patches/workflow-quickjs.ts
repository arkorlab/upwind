import { createHash } from 'node:crypto';

import { arkorWasmGlobal } from '../wasm.ts';
import { EMBEDDED_WASM_CALL, isQuickjsAssetsChunk } from '../workflow.ts';
import { type Patch, Rewrite } from './types.ts';

/** How much of a call a refusal quotes, to say which one it could not read. */
const QUOTED_CHARACTERS = 40;

/**
 * The Workflow SDK's QuickJS engine carries its WebAssembly in its own source:
 *
 * ```js
 * function decodeBase64(b64) { … return Buffer.from(b64, 'base64') … }
 * const quickjsWasm = decodeBase64('AGFzbQEAAAA…');
 * export const quickjsExtensions = [{ name: 'encoding', wasm: decodeBase64('AGFzbQEAAAA…') }, …];
 * ```
 *
 * and compiles it with `WebAssembly.compile` on the first run, which workerd refuses: no code is
 * generated at run time there, WebAssembly included. So each embedded module becomes a module the
 * Function carries — Cloudflare compiles it when the Function is uploaded — and each call that
 * decoded one becomes a read of the global `wasm.mjs` publishes it under. The bytes are not in the
 * bundle any more, which is a megabyte and a half of strings the Function no longer parses.
 *
 * What the engine then hands `WebAssembly.compile` is a module that is already compiled, which the
 * workflow Function's runtime answers with that very module (`workflow.ts` in the runtime): the
 * engine's own loader for its extensions already takes a module as it is.
 *
 * The chunk is found by `marker`, since Turbopack names it by a hash; each module it embeds must
 * have been offered to the Function before it was bundled (`offerEmbeddedWasm`), so a literal the
 * patch does not find published fails the build rather than a run. The minifier may name the
 * decoder anything; it stays one identifier called with one string literal.
 */

const NAME = 'workflow-quickjs-wasm';
const TARGET = /\/server\/chunks\/.*\.js$/u;
const BASE64_OF_CALL = /(?<quote>["'`])(?<base64>AGFzbQEAAAA[\d+/A-Za-z]*={0,2})\k<quote>/u;
/** What would mean a module was left behind, still to be decoded and compiled. */
const LEFTOVERS = [/["'`]AGFzbQEAAAA/u];

function sha256Of(base64: string): string {
  return createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
}

export const workflowQuickjsWasmPatch: Patch = {
  name: NAME,
  target: TARGET,
  marker: isQuickjsAssetsChunk,
  // The chunk Turbopack put the SDK's asset module in, which only a build has.
  reaches: ['build-output'],
  apply(source, file, ctx) {
    const rewrite = new Rewrite(NAME, file, source);
    const count = [...source.matchAll(EMBEDDED_WASM_CALL)].length;
    if (count === 0) {
      throw rewrite.fail('it embeds no WebAssembly module in the shape this patch reads');
    }
    const published = ctx.embeddedWasm ?? new Set<string>();
    const globals: string[] = [];
    const result = rewrite
      .replace(
        EMBEDDED_WASM_CALL,
        (match) => {
          const base64 = BASE64_OF_CALL.exec(match)?.groups?.['base64'];
          if (base64 === undefined) {
            throw rewrite.fail(
              `could not read the module out of ${match.slice(0, QUOTED_CHARACTERS)}…`,
            );
          }
          const sha256 = sha256Of(base64);
          if (!published.has(sha256)) {
            throw rewrite.fail(`the module ${sha256} was not offered to this Function`);
          }
          const global = arkorWasmGlobal(sha256);
          globals.push(global);
          return `globalThis.${global}`;
        },
        count,
        'an embedded WebAssembly module',
      )
      .forbid(LEFTOVERS, 'an embedded WebAssembly module');
    return {
      contents: result.contents,
      edits: result.edits,
      notes: [`embedded WebAssembly: ${String(count)} modules (${globals.join(', ')})`],
    };
  },
};
