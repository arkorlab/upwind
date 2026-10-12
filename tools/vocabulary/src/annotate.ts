import type { Hit } from './scan.ts';

/**
 * A value as a workflow command carries it (`escapeData` in `@actions/core`): the `%` and the line
 * breaks that would end the command and begin another, escaped.
 */
function commandData(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/**
 * A property of a workflow command (`escapeProperty`): what `commandData` escapes, and the `:` and
 * `,` that would end the property — any of which a file's name may hold.
 */
function commandProperty(value: string): string {
  return commandData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

/** A mention as GitHub annotates it on the line that makes it: an `::error` workflow command. */
export function annotationOf(hit: Hit): string {
  const title = `vocabulary/${hit.term.id}`;
  const message = `${JSON.stringify(hit.text)}: ${hit.term.why}`;
  const properties = [
    `file=${commandProperty(hit.file)}`,
    `line=${String(hit.line)}`,
    `col=${String(hit.column)}`,
    `title=${commandProperty(title)}`,
  ].join(',');
  return `::error ${properties}::${commandData(message)}`;
}
