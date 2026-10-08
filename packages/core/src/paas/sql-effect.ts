/** D1 raw/exec omit metadata. Classify only their successful statements, without altering SQL. */
export type SqlEffect = 'read' | 'write' | 'unknown';

interface Token {
  readonly value: string;
  readonly depth: number;
}

/** Comments and quoted values cannot turn a read into a write, or conceal a CTE's final verb. */
function tokensOf(sql: string): Token[][] {
  const statements: Token[][] = [[]];
  let depth = 0;
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i + 2);
      i = end === -1 ? sql.length : end + 1;
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      i++;
      while (i < sql.length) {
        if (sql[i] === close) {
          i++;
          if (sql[i] !== close || close === ']') break;
        }
        i++;
      }
    } else if (c === '(') {
      depth++;
      i++;
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (c === ';' && depth === 0) {
      statements.push([]);
      i++;
    } else if (c !== undefined && /[a-z_]/iu.test(c)) {
      const start = i++;
      while (i < sql.length && /[\w$]/u.test(sql[i] ?? '')) i++;
      statements.at(-1)?.push({ value: sql.slice(start, i).toUpperCase(), depth });
    } else {
      if (c === '=') statements.at(-1)?.push({ value: '=', depth });
      i++;
    }
  }
  return statements.filter((statement) => statement.length > 0);
}

const WRITES = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'CREATE',
  'ALTER',
  'DROP',
  'VACUUM',
  'REINDEX',
  'ANALYZE',
  'ATTACH',
  'DETACH',
]);
const READ_PRAGMAS = new Set([
  'TABLE_INFO',
  'TABLE_XINFO',
  'INDEX_LIST',
  'INDEX_INFO',
  'INDEX_XINFO',
  'FOREIGN_KEY_LIST',
  'DATABASE_LIST',
  'COMPILE_OPTIONS',
  'FOREIGN_KEY_CHECK',
  'INTEGRITY_CHECK',
  'QUICK_CHECK',
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
