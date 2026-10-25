import { jsLiteral } from './codegen.ts';
import { AuditError, auditFunction, type FunctionDependencies } from './dependencies.ts';

/** Next.js's existing per-entry trace; no package discovery or native module loading. */
export interface NativeAddonEntryTrace {
  readonly id: string;
  readonly assets: Readonly<Record<string, string>>;
}

const MAX_ENTRIES = 5;
const MAX_FILES = 3;
const MAX_LABEL_CHARACTERS = 180;

function label(value: string): string {
  const shortened =
    value.length > MAX_LABEL_CHARACTERS ? `${value.slice(0, MAX_LABEL_CHARACTERS)}…` : value;
  return jsLiteral(shortened);
}

/** Add bounded trace context to a refusal; a native asset alone is not proof it was invoked. */
export function nativeAddonAuditError(
  error: AuditError,
  traces: readonly NativeAddonEntryTrace[],
): AuditError {
  const entries = traces
    .map((entry) => {
      const files = Object.entries(entry.assets)
        .filter(([, file]) => file.endsWith('.node'))
        .map(([name]) => name)
        .toSorted((left, right) => left.localeCompare(right));
      return { id: entry.id, files };
    })
    .filter((entry) => entry.files.length > 0)
    .toSorted((left, right) => left.id.localeCompare(right.id));
  if (entries.length === 0) return error;
  const lines = entries.slice(0, MAX_ENTRIES).map((entry) => {
    const files = entry.files.slice(0, MAX_FILES).map((file) => label(file));
    const omitted = entry.files.length - files.length;
    const suffix = omitted === 0 ? '' : ` (+${String(omitted)} more traced files)`;
    return `  - ${label(entry.id)}: ${files.join(', ')}${suffix}`;
  });
  const omittedEntries = entries.length - lines.length;
  if (omittedEntries > 0) lines.push(`  - ${String(omittedEntries)} more server entries`);
  return new AuditError(
    [
      error.message,
      '',
      'This Function also traces native Node.js addons from these server entries:',
      ...lines,
      'These traces do not establish that an addon was invoked.',
      'Native packages used only by build tooling need no Workers runtime support. A prerendered response does not make its server entry build-only: draft, bypass, revalidation or fallback can still invoke it.',
    ].join('\n'),
    { cause: error },
  );
}

/** The existing graph audit, with diagnostic context on its own refusal and nothing else. */
export function auditNativeFunction(input: {
  readonly name: string;
  readonly sources: Parameters<typeof auditFunction>[1];
  readonly dependencies: FunctionDependencies;
  readonly output: string;
  readonly entryTraces: readonly NativeAddonEntryTrace[];
}): void {
  try {
    auditFunction(input.name, input.sources, input.dependencies, input.output);
  } catch (error) {
    if (error instanceof AuditError) throw nativeAddonAuditError(error, input.entryTraces);
    throw error;
  }
}
