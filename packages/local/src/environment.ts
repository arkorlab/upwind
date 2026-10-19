import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/** A name `parseEnv` sets on the object it returns rather than keeping as one of its own. */
const PROTO = '__proto__';
const EXPORT = 'export';

type Parsed = ReturnType<typeof parseEnv>;

/** A line of a `.env` file, the name it declares read as `alias` where that is `__proto__`. */
function aliased(line: string, alias: string): string {
  const body = line.trimStart();
  const exported = body.startsWith(`${EXPORT} `) || body.startsWith(`${EXPORT}\t`);
  const declared = exported ? body.slice(EXPORT.length).trimStart() : body;
  if (!declared.startsWith(PROTO) || !declared.slice(PROTO.length).trimStart().startsWith('=')) {
    return line;
  }
  const at = line.length - declared.length;
  return `${line.slice(0, at)}${alias}${line.slice(at + PROTO.length)}`;
}

/**
 * The value a file gives `__proto__`, which `parseEnv` loses. Each line that reads like a
 * declaration of it is read under an alias of the stack's own, and taken for one only where Node
 * reads it so — reading every other variable as it did without the alias: a line inside a quoted
 * value that spans lines (`A="…⏎__proto__=…⏎…"`) changes that value when aliased, and is left as
 * part of it. The last declaration wins, as it does for any other name.
 */
function protoOf(text: string, parsed: Parsed): string | undefined {
  const lines = text.split('\n');
  let value: string | undefined;
  for (const [index, line] of lines.entries()) {
    const alias = `UPWIND_LOCAL_${crypto.randomUUID().replaceAll('-', '_')}`;
    const renamed = aliased(line, alias);
    if (renamed === line) {
      continue;
    }
    const trial = parseEnv(lines.with(index, renamed).join('\n'));
    const unchanged = Object.entries(parsed).every(([name, kept]) => trial[name] === kept);
    if (unchanged && trial[alias] !== undefined) {
      value = trial[alias];
    }
  }
  return value;
}

/**
 * The variables the files hold, each read as Node reads a `.env` file — `__proto__` among them, a
 * name a deployment's environment may hold like any other — and a later file's value of a name
 * winning.
 */
export function environmentOf(files: readonly string[]): Record<string, string> {
  const env = new Map<string, string>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const parsed = parseEnv(text);
    for (const [name, value] of Object.entries(parsed)) {
      if (value !== undefined) {
        env.set(name, value);
      }
    }
    const proto = protoOf(text, parsed);
    if (proto !== undefined) {
      env.set(PROTO, proto);
    }
  }
  // As entries, each made the record's own.
  return Object.fromEntries(env);
}
