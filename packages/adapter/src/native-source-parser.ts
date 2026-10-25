import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';

/** CommonJS permits a top-level return; failed parsing must never bypass capability analysis. */
export function parseNativeSource(source: string, file: string): ReturnType<typeof parseAst> {
  try {
    return parseAst(
      source,
      {
        lang: 'js',
        sourceType: file.endsWith('.cjs') ? 'commonjs' : 'unambiguous',
      },
      file,
    );
  } catch {
    if (!file.endsWith('.mjs')) {
      try {
        return parseAst(source, { lang: 'js', sourceType: 'commonjs' }, file);
      } catch {
        // Refuse rather than treating an unparsed executable module as native-free.
      }
    }
    throw new AuditError('Native capability analysis cannot parse an executable module');
  }
}
