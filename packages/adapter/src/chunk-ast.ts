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
 * and `parseAst` throws `Failed to convert rust String into napi string` instead. oxc-parser's raw
 * transfer hands the same tree over in a buffer. With the options `parseAst` sets (`lang: 'js'`, no
 * `ParenthesizedExpression`), it answers that tree node for node, and the analyses that walk it see
 * no difference. Where raw transfer is not supported, and for a chunk that does not parse, `parseAst`
 * answers as before: its error is the one a build reports.
 *
 * So it does where raw transfer throws. Its deserializer spreads each list of a body into one call
 * (`body.push(...)`), so a body of some 200,000 statements or more is past what a call takes, and it
 * throws `RangeError: Maximum call stack size exceeded` where `parseAst` reads the chunk.
 */
export function parseChunk(code: string): Program {
  if (!rawTransferSupported()) return parseAst(code);
  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(FILE, code, OPTIONS);
  } catch {
    return parseAst(code);
  }
  return parsed.errors.length > 0 ? parseAst(code) : parsed.program;
}
