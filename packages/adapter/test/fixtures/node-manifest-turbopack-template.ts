import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { parseAst } from 'rolldown/parseAst';

import { jsLiteral } from '../../src/codegen.ts';
import { isNode, listOf, type Node } from '../../src/lexical-scope.ts';
import { stringOf, visitTree } from '../../src/node-manifest-consumer-ast.ts';
import { swcTemplateExports } from '../../src/node-manifest-template-exports.ts';
import {
  type NodeManifestTurbopackTemplateInput,
} from '../../src/node-manifest-turbopack-templates.ts';
import {
  projectNodeManifestTurbopackFactory,
  type NodeManifestTurbopackSource,
} from '../../src/node-manifest-turbopack.ts';

const USERLAND_MODULE_ID_BASE = 100;

export function manifestTemplateSource(code: string): NodeManifestTurbopackSource {
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}
function program(code: string): Node {
  const value: unknown = parseAst(code);
  if (!isNode(value)) throw new Error('Expected an inert primary-source program');
  return value;
}
export function reprojectTemplateFixture(
  input: NodeManifestTurbopackTemplateInput,
  code: string,
): NodeManifestTurbopackTemplateInput {
  return { ...input, projection: projectNodeManifestTurbopackFactory(manifestTemplateSource(code), 1) };
}
interface Edit {
  readonly start: number;
  readonly end: number;
  readonly code: string;
}
interface Imports {
  readonly imported: { specifier: string; file: string; sha256: string }[];
  readonly edits: Edit[];
  readonly slots: Map<string, number>;
}
async function templateCode(
  file: string,
  route: NodeManifestTurbopackTemplateInput['route'],
): Promise<string> {
  const code = (await readFile(file, 'utf8'))
    .replaceAll('VAR_DEFINITION_PAGE', () => route.page)
    .replaceAll('VAR_DEFINITION_PATHNAME', () => route.pathname)
    .replaceAll('VAR_DEFINITION_FILENAME', 'route')
    .replaceAll('VAR_DEFINITION_BUNDLE_PATH', 'app/stream/route')
    .replaceAll('VAR_RESOLVED_PAGE_PATH', '/fixture/app/stream/route.ts');
  return route.kind === 'app-route'
    ? code.replace(
        'const routeModule =',
        'const nextConfigOutput = undefined;\nconst routeModule =',
      )
    : code;
}
function slotImport(node: Node, specifier: string, state: Imports): void {
  let id = state.slots.get(specifier);
  if (id === undefined) {
    id = state.slots.size + USERLAND_MODULE_ID_BASE;
    state.slots.set(specifier, id);
  }
  const target = `turbopack:${id}`;
  if (state.imported.every((entry) => entry.specifier !== target))
    state.imported.push({
      specifier: target,
      file: `/fixture/${specifier}.js`,
      sha256: manifestTemplateSource(specifier).sha256,
    });
  state.edits.push({ start: node.start, end: node.end, code: `runtimeContext.i(${id})` });
}
async function externalImport(
  node: Node,
  specifier: string,
  file: string,
  state: Imports,
): Promise<void> {
  const physical = await realpath(createRequire(file).resolve(specifier));
  if (state.imported.every((entry) => entry.specifier !== specifier))
    state.imported.push({
      specifier,
      file: physical,
      sha256: manifestTemplateSource(await readFile(physical, 'utf8')).sha256,
    });
  state.edits.push({
    start: node.start,
    end: node.end,
    code: `runtimeContext.x(${jsLiteral(specifier)},()=>require(${jsLiteral(specifier)}))`,
  });
}
async function importRecords(parsed: Node, file: string): Promise<Imports> {
  const state: Imports = { imported: [], edits: [], slots: new Map() };
  for (const visit of visitTree(parsed)) {
    const node = visit.node;
    const callee = node['callee'];
    if (node.type !== 'CallExpression' || !isNode(callee) || callee['name'] !== 'require') continue;
    const specifier = stringOf(listOf(node, 'arguments')[0]);
    if (specifier === undefined) throw new Error('Unexpected dynamic import in primary template');
    if (specifier.startsWith('VAR_')) slotImport(node, specifier, state);
    else await externalImport(node, specifier, file, state);
  }
  return state;
}
function editedStatements(
  code: string,
  body: readonly unknown[],
  edits: readonly Edit[],
): string[] {
  const statements: string[] = [];
  for (const statement of body) {
    if (!isNode(statement)) throw new Error('Expected a primary source statement');
    let text = code.slice(statement.start, statement.end);
    const inside = edits
      .filter((edit) => edit.start >= statement.start && edit.end <= statement.end)
      .toSorted((left, right) => right.start - left.start);
    for (const edit of inside)
      text =
        text.slice(0, edit.start - statement.start) +
        edit.code +
        text.slice(edit.end - statement.start);
    statements.push(text);
  }
  return statements;
}
export async function projectedTemplateFixture(kind: NodeManifestTurbopackTemplateInput['route']['kind']): Promise<NodeManifestTurbopackTemplateInput> {
  const file = await realpath(
    fileURLToPath(import.meta.resolve(`next/dist/build/templates/${kind}.js`)),
  );
  const definitions = {
    pages: { page: '/blog/[slug]', pathname: '/blog/[slug]' },
    'app-route': { page: '/stream/route', pathname: '/stream' },
    'pages-api': { page: '/api/native', pathname: '/api/native' },
  };
  const route = { kind, ...definitions[kind] };
  const code = await templateCode(file, route);
  const parsed = program(code);
  const view = swcTemplateExports(parsed);
  const { imported, edits } = await importRecords(parsed, file);
  const statements = editedStatements(code, view.body, edits);
  const fields: string[] = [];
  for (const [name, value] of view.fields)
    fields.push(`${jsLiteral(name)},()=>${code.slice(value.start, value.end)}`);
  statements.splice(1, 0, `runtimeContext.s([${fields.join(',')}]);`);
  const original = manifestTemplateSource(`module.exports=[1,(runtimeContext)=>{${statements.join('\n')}}];`);
  return { projection: projectNodeManifestTurbopackFactory(original, 1), imports: imported, route };
}
export function changeOriginalTemplateFixture(
  input: NodeManifestTurbopackTemplateInput,
  before: string,
  after: string,
): NodeManifestTurbopackTemplateInput {
  const code = input.projection.original.code.replace(before, () => after);
  if (code === input.projection.original.code) throw new Error('Expected primary-source mutation');
  return reprojectTemplateFixture(input, code);
}

