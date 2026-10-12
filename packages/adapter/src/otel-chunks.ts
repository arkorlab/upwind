import { readFile } from 'node:fs/promises';

import type { ArrayExpression, Expression, Program } from '@oxc-project/types';
import { type Plugin, RolldownMagicString } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';

import { jsLiteral } from './codegen.ts';
import { VENDORED_OTEL_API } from './patches/vendored-otel.ts';

/**
 * The OpenTelemetry API, once in a Function rather than once for every layer Turbopack compiled
 * Next.js's tracer into.
 *
 * Next.js's tracer requires the application's `@opentelemetry/api` and, when that throws, the copy
 * Next.js ships (`server/lib/trace/tracer.ts`). Turbopack compiles the tracer into the chunks of
 * every layer that reaches it — the pages', the route handlers', the middleware's — and resolves both
 * requires as it builds them: each layer's chunks hold the API as a module of their own, and Next.js's
 * copy beside it, which only the `catch` would ever run. The tracer Next.js's server requires outside
 * the chunks is bundled with a copy of its own. The minimal fixture's app Function carried the API
 * seven times, 135 KB of it, and its middleware's Function three times.
 *
 * Each of those modules becomes what Turbopack writes for an external: a require the bundler follows,
 * of Next.js's copy, which `vendoredOtelPlugin` resolves to the application's own as Next.js's
 * modules find it, and to Next.js's copy only where there is none. That is the module the tracer
 * outside the chunks is bundled with, so the Function carries the API once, and every tracer reads
 * the release it read before. The API keeps its state on a global, by major version, so a tracer
 * provider the application's instrumentation registers is the one every copy reads: one copy
 * answers as the copies did, and is the only one a Function compiles as it starts.
 *
 * Which modules those are is read off the tracer as Turbopack wrote it, before anything is bundled
 * (`tracerApiModules`): its `try` and its `catch`, each the require of one module by its id, then
 * what it takes of the one it got. A module is rewritten only where it is in a chunk's table under
 * that id alone, and carries the key the API keeps its state under — a copy of the API, whole. A
 * build whose tracer reads otherwise, or that Turbopack did not minify, keeps its copies.
 */

/** A module Turbopack wrote for the server, by the path the bundler read it at. */
const SERVER_CHUNK = /[/\\]server[/\\]chunks[/\\]/u;

/**
 * The tracer's requires as Turbopack writes them into a chunk, minified:
 * `try{d=a.r(32528)}catch(b){d=a.r(96756)}` — the application's API in the `try`, and Next.js's
 * copy in the `catch`.
 */
const TRACER_REQUIRES =
  /try\{(?<api>[\w$]+)=(?<context>[\w$]+)\.r\((?<own>\d+)\)\}catch(?:\([\w$]+\))?\{\k<api>=\k<context>\.r\((?<vendored>\d+)\)\}/gu;
/**
 * And right after them, what makes them the tracer's: the six members it takes of the module it
 * got, `let{context:l,propagation:m,trace:n,SpanStatusCode:o,SpanKind:p,ROOT_CONTEXT:q}=d`.
 */
const TRACER_TAKES =
  /(?:const|let|var) ?\{context:[\w$]+,propagation:[\w$]+,trace:[\w$]+,SpanStatusCode:[\w$]+,SpanKind:[\w$]+,ROOT_CONTEXT:[\w$]+\}=(?<api>[\w$]+)/uy;

/** What every copy of the API keeps its state under (`internal/global-utils`), and nothing else does. */
const GLOBAL_KEY = 'opentelemetry.js.api.';

/** What a copy becomes: an external, as Turbopack writes one, of the copy the bundler resolves. */
const EXTERNAL = `(e,r)=>{r.exports=e.x(${jsLiteral(VENDORED_OTEL_API)},()=>require(${jsLiteral(VENDORED_OTEL_API)}))}`;

/** The ids of the modules the tracer in `chunks` requires the API by, the one in its `catch` too. */
export async function tracerApiModules(chunks: readonly string[]): Promise<ReadonlySet<number>> {
  const modules = new Set<number>();
  await Promise.all(
    chunks.map(async (file) => {
      const source = await readFile(file, 'utf8');
      for (const requires of source.matchAll(TRACER_REQUIRES)) {
        TRACER_TAKES.lastIndex = requires.index + requires[0].length;
        const takes = TRACER_TAKES.exec(source);
        if (takes !== null && takes.groups?.['api'] === requires.groups?.['api']) {
          modules.add(Number(requires.groups?.['own']));
          modules.add(Number(requires.groups?.['vendored']));
        }
      }
    }),
  );
  return modules;
}

/** A module of a chunk's table: the ids it is installed under, and where its factory is. */
interface TableEntry {
  readonly ids: readonly number[];
  readonly factory: { readonly start: number; readonly end: number };
}

function isFactory(element: Expression): boolean {
  return element.type === 'ArrowFunctionExpression' || element.type === 'FunctionExpression';
}

/**
 * The entries of a chunk's table, as Turbopack's runtime installs them: a list of entries first,
 * where there is one, then ids followed by the factory each of them is installed with.
 */
function entriesOf(table: ArrayExpression): TableEntry[] {
  const entries: TableEntry[] = [];
  let ids: number[] = [];
  for (const [at, element] of table.elements.entries()) {
    if (element === null || element.type === 'SpreadElement') {
      ids = [];
    } else if (at === 0 && element.type === 'ArrayExpression') {
      entries.push(...entriesOf(element));
    } else if (element.type === 'Literal' && typeof element.value === 'number') {
      ids.push(element.value);
    } else {
      if (isFactory(element) && ids.length > 0) {
        entries.push({ ids, factory: { start: element.start, end: element.end } });
      }
      ids = [];
    }
  }
  return entries;
}

/** The table a chunk is: the list its `module.exports` is assigned. */
function tableOf(program: Program): ArrayExpression | undefined {
  for (const statement of program.body) {
    if (statement.type !== 'ExpressionStatement') {
      continue;
    }
    const { expression } = statement;
    if (
      expression.type === 'AssignmentExpression' &&
      expression.operator === '=' &&
      expression.left.type === 'MemberExpression' &&
      !expression.left.computed &&
      expression.left.object.type === 'Identifier' &&
      expression.left.object.name === 'module' &&
      expression.left.property.name === 'exports' &&
      expression.right.type === 'ArrayExpression'
    ) {
      return expression.right;
    }
  }
  return undefined;
}

/** Where in `code`, a chunk, the factories of the copies of the API among `modules` are. */
export function apiFactories(
  code: string,
  modules: ReadonlySet<number>,
): { readonly start: number; readonly end: number }[] {
  const table = tableOf(parseAst(code, { lang: 'js' }));
  if (table === undefined) {
    return [];
  }
  return entriesOf(table)
    .filter(({ ids, factory }) => {
      const [id] = ids;
      return (
        ids.length === 1 &&
        id !== undefined &&
        modules.has(id) &&
        code.slice(factory.start, factory.end).includes(GLOBAL_KEY)
      );
    })
    .map(({ factory }) => factory);
}

/**
 * The plugin, for the Functions' bundles: the modules read off `chunks` as the build starts, and
 * every copy of them made the external as each chunk is loaded.
 */
export function otelChunksPlugin(chunks: readonly string[]): Plugin {
  let modules: ReadonlySet<number> = new Set();
  return {
    name: 'arkor-otel-chunks',
    async buildStart() {
      modules = await tracerApiModules(chunks);
    },
    transform: {
      filter: { id: SERVER_CHUNK, code: GLOBAL_KEY },
      handler(code) {
        const factories = modules.size === 0 ? [] : apiFactories(code, modules);
        if (factories.length === 0) {
          return null;
        }
        const rewritten = new RolldownMagicString(code);
        for (const { start, end } of factories) {
          rewritten.overwrite(start, end, EXTERNAL);
        }
        return { code: rewritten };
      },
    },
  };
}
