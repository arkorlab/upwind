import { parseAst } from 'rolldown/parseAst';
import { transformSync } from 'rolldown/utils';

import { AuditError } from './dependencies.ts';

const MAX_SOURCE_MEBIBYTES = 128;
const BYTES_PER_MEBIBYTE = 1_048_576;
const MAX_SOURCE_BYTES = MAX_SOURCE_MEBIBYTES * BYTES_PER_MEBIBYTE;
const PARSE_FAILURE = 'Native capability analysis cannot parse an executable module';

export interface NativeSourceAnalysis {
  readonly code: string;
  /** Offsets refer to code, not to the unchanged physical TypeScript source. */
  readonly program: ReturnType<typeof parseAst>;
}

function language(file: string): 'ts' | 'tsx' | 'jsx' | undefined {
  if (/\.[cm]?tsx$/u.test(file)) return 'tsx';
  if (/\.[cm]?ts$/u.test(file)) return 'ts';
  return /\.[cm]?jsx$/u.test(file) ? 'jsx' : undefined;
}

function analysisCode(
  source: string,
  file: string,
  sourceType: 'unambiguous' | 'commonjs',
  preserveValueImports: boolean,
): string {
  const lang = language(file);
  if (lang === undefined) return source;
  const transformed = transformSync(file, source, {
    lang,
    sourceType,
    tsconfig: false,
    target: 'esnext',
    typescript: { onlyRemoveTypeImports: preserveValueImports },
  });
  if (
    transformed.errors.length > 0 ||
    transformed.warnings.length > 0 ||
    Buffer.byteLength(transformed.code) > MAX_SOURCE_BYTES
  )
    throw new AuditError(PARSE_FAILURE);
  return transformed.code;
}

function analyze(
  source: string,
  file: string,
  sourceType: 'unambiguous' | 'commonjs',
  preserveValueImports: boolean,
): NativeSourceAnalysis {
  const code = analysisCode(source, file, sourceType, preserveValueImports);
  const program = parseAst(code, { lang: 'js', sourceType }, file);
  return Object.freeze({ code, program });
}

/**
 * Trusted syntax lowering is inspection-only. It erases ambient types and retains runtime enum,
 * namespace and JSX expressions before capability analysis; it never authorizes raw Node TSX/enum
 * execution or changes the original files copied into a Node artifact.
 */
export function nativeSourceAnalysis(
  source: string,
  file: string,
  options: { readonly target?: 'node' | 'worker' } = {},
): NativeSourceAnalysis {
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) throw new AuditError(PARSE_FAILURE);
  // Raw Node stripping keeps non-type imports; placement retains the Worker's ordinary elision.
  const preserveValueImports = options.target !== 'worker';
  try {
    return analyze(
      source,
      file,
      file.endsWith('.cjs') ? 'commonjs' : 'unambiguous',
      preserveValueImports,
    );
  } catch {
    if (!/\.m[jt]s$/u.test(file)) {
      try {
        return analyze(source, file, 'commonjs', preserveValueImports);
      } catch {
        // Refuse rather than treating an unparsed executable module as native-free.
      }
    }
    throw new AuditError(PARSE_FAILURE);
  }
}

/** Non-rewriting callers inspect the same emitted JavaScript semantics. */
export function parseNativeSource(source: string, file: string): ReturnType<typeof parseAst> {
  return nativeSourceAnalysis(source, file).program;
}
