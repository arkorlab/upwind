import type { Program } from '@oxc-project/types';
import { type ParserOptions, parseSync, rawTransferSupported } from 'oxc-parser';
import { parseAst } from 'rolldown/parseAst';

/** The name `parseAst` gives a source it is handed without one. */
const FILE = 'file.js';

/**
 * `parseAst`'s options, and raw transfer, which `parseSync` reads (`src-js/index.js`) though its
 * declarations leave it out.
 */
const OPTIONS: ParserOptions & { readonly experimentalRawTransfer: true } = {
  experimentalRawTransfer: true,
  lang: 'js',
  preserveParens: false,
};

/**
 * A whole output chunk's syntax tree, as `parseAst` answers it.
 *
 * `parseAst` hands its tree back as one JSON string, and a JavaScript string has a length V8 will not
 * make one past: an application's chunk of some 30 million characters has a tree longer than that,
 * and `parseAst` throws `Failed to convert rust String into napi string` instead. Where it throws,
 * oxc-parser's raw transfer is asked, which hands the same tree over in a buffer. With the options
 * `parseAst` sets (`lang: 'js'`, no `ParenthesizedExpression`), it answers that tree node for node,
 * and the analyses that walk it see no difference.
 *
 * Raw transfer is the second answer, not the first. It reserves 6 GiB of address space for each parse
 * and keeps the buffer for reuse, which a chunk `parseAst` reads has no need of. Its deserializer also
 * spreads each list of a body into one call (`body.push(...)`), so it throws on a body of some
 * 200,000 statements, which `parseAst` reads. Where raw transfer cannot read the chunk either — it
 * is not supported, the chunk does not parse, or it throws — `parseAst`'s own error is the one a build
 * reports.
 */
export function parseChunk(code: string): Program {
  try {
    return parseAst(code);
  } catch (error) {
    const tree = rawTransferTree(code);
    if (tree === undefined) throw error;
    return tree;
  }
}

/** The chunk's tree through raw transfer, or `undefined` where raw transfer cannot read it. */
function rawTransferTree(code: string): Program | undefined {
  if (!rawTransferSupported()) return undefined;
  try {
    const { program, errors } = parseSync(FILE, code, OPTIONS);
    return errors.length > 0 ? undefined : program;
  } catch {
    return undefined;
  }
}
