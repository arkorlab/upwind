/** D1 raw/exec omit metadata. Classify only their successful statements, without altering SQL. */
export type SqlEffect = 'read' | 'write' | 'unknown';

interface Token {
  readonly value: string;
  readonly depth: number;
}

function commentEnd(sql: string, start: number): number | undefined {
  if (sql.startsWith('--', start)) {
    const end = sql.indexOf('\n', start + 2);
    return end === -1 ? sql.length : end + 1;
  }
  if (sql.startsWith('/*', start)) {
    const end = sql.indexOf('*/', start + 2);
    return end === -1 ? sql.length : end + 2;
  }
  return undefined;
}

function quotedEnd(sql: string, start: number, opening: string): number {
  const close = opening === '[' ? ']' : opening;
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] !== close) {
      index += 1;
      continue;
    }
    index += 1;
    if (close === ']' || sql[index] !== close) return index;
    index += 1;
  }
  return index;
}

function wordEnd(sql: string, start: number): number {
  let index = start + 1;
  while (index < sql.length && /[\w$]/u.test(sql[index] ?? '')) index += 1;
  return index;
}

function appendToken(
  sql: string,
  start: number,
  depth: number,
  statement: Token[] | undefined,
): number {
  const character = sql.charAt(start);
  if (/[a-z_]/iu.test(character)) {
    const end = wordEnd(sql, start);
    statement?.push({ value: sql.slice(start, end).toUpperCase(), depth });
    return end;
  }
  if (character === '=') statement?.push({ value: '=', depth });
  return start + 1;
}

/** Comments and quoted values cannot turn a read into a write, or conceal a CTE's final verb. */
function tokensOf(sql: string): Token[][] {
  const statements: Token[][] = [[]];
  let depth = 0;
  for (let index = 0; index < sql.length;) {
    const comment = commentEnd(sql, index);
    if (comment !== undefined) {
      index = comment;
      continue;
    }
    const character = sql.charAt(index);
    switch (character) {
      case "'":
      case '"':
      case '`':
      case '[': {
        index = quotedEnd(sql, index, character);
        break;
      }
      case '(': {
        depth += 1;
        index += 1;
        break;
      }
      case ')': {
        depth = Math.max(0, depth - 1);
        index += 1;
        break;
      }
      case ';': {
        if (depth === 0) statements.push([]);
        index += 1;
        break;
      }
      default: {
        index = appendToken(sql, index, depth, statements.at(-1));
      }
    }
  }
  return statements.filter((statement) => statement.length > 0);
}

const WRITES = new Set([
  'ALTER',
  'ANALYZE',
  'ATTACH',
  'CREATE',
  'DELETE',
  'DETACH',
  'DROP',
  'INSERT',
  'REINDEX',
  'REPLACE',
  'UPDATE',
  'VACUUM',
]);
const READ_PRAGMAS = new Set([
  'COMPILE_OPTIONS',
  'DATABASE_LIST',
  'FOREIGN_KEY_CHECK',
  'FOREIGN_KEY_LIST',
  'INDEX_INFO',
  'INDEX_LIST',
  'INDEX_XINFO',
  'INTEGRITY_CHECK',
  'QUICK_CHECK',
  'TABLE_INFO',
  'TABLE_XINFO',
]);

function effectOf(tokens: readonly Token[]): SqlEffect {
  const top = tokens.filter((token) => token.depth === 0).map((token) => token.value);
  let verb = top[0];
  if (verb === 'EXPLAIN') return 'read';
  if (verb === 'WITH') {
    verb = top.find((value, index) => index > 0 && (value === 'SELECT' || WRITES.has(value)));
  }
  if (verb === 'SELECT' || verb === 'VALUES') return 'read';
  if (verb !== undefined && WRITES.has(verb)) return 'write';
  if (verb === 'PRAGMA' && !top.includes('=') && READ_PRAGMAS.has(top.at(-1) ?? '')) return 'read';
  return 'unknown';
}

export function sqlEffect(sql: string): SqlEffect {
  const statements = tokensOf(sql);
  let result: SqlEffect = 'read';
  for (const statement of statements) {
    const effect = effectOf(statement);
    if (effect === 'write') return 'write';
    if (effect === 'unknown') result = 'unknown';
  }
  return result;
}
