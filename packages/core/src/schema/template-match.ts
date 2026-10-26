/** A Unicode regexp cannot end or begin an atom in the middle of a surrogate pair. */
function boundary(value: string, index: number): boolean {
  const before = value.charCodeAt(index - 1);
  const after = value.charCodeAt(index);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

interface Literal {
  readonly value: string;
  readonly failures: readonly number[];
}

function literal(value: string): Literal {
  const failures = Array.from({ length: value.length }, () => 0);
  for (let index = 1, matched = 0; index < value.length; index += 1) {
    while (matched > 0 && value[index] !== value[matched]) matched = failures[matched - 1] ?? 0;
    if (value[index] === value[matched]) matched += 1;
    failures[index] = matched;
  }
  return { value, failures };
}

/** KMP scans once, including where a candidate would split a surrogate pair. */
function find(part: Literal, input: string, from: number, to: number): number {
  let matched = 0;
  for (let index = from; index < to; index += 1) {
    while (matched > 0 && input[index] !== part.value[matched]) {
      matched = part.failures[matched - 1] ?? 0;
    }
    if (input[index] === part.value[matched]) matched += 1;
    if (matched === part.value.length) {
      const start = index + 1 - matched;
      if (boundary(input, start) && boundary(input, index + 1)) return index + 1;
      matched = part.failures[matched - 1] ?? 0;
    }
  }
  return -1;
}

/** Literal runs separated by arbitrary Unicode strings, without regexp backtracking. */
export function templateMatcher(
  parts: readonly (string | undefined)[],
): (input: string) => boolean {
  const runs = [''];
  let wildcard = false;
  for (const part of parts) {
    if (part === undefined) {
      if (!wildcard) runs.push('');
      wildcard = true;
    } else {
      runs[runs.length - 1] += part;
      if (part !== '') wildcard = false;
    }
  }
  const prefix = runs[0] ?? '';
  if (runs.length === 1) return (input) => input === prefix;
  const suffix = runs.at(-1) ?? '';
  const middle = runs
    .slice(1, -1)
    .filter((part) => part !== '')
    .map(literal);
  return (input) => {
    const end = input.length - suffix.length;
    if (
      prefix.length > end ||
      !input.startsWith(prefix) ||
      !input.endsWith(suffix) ||
      !boundary(input, prefix.length) ||
      !boundary(input, end)
    )
      return false;
    let cursor = prefix.length;
    for (const part of middle) {
      cursor = find(part, input, cursor, end);
      if (cursor === -1) return false;
    }
    return true;
  };
}
