import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { parseAst } from 'rolldown/parseAst';

import { beneath } from './build-paths.ts';
import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node } from './lexical-scope.ts';
import {
  identifier,
  propertyName,
  stringOf,
  visitTree,
  type Visit,
} from './node-manifest-consumer-ast.ts';

const MAX_TEMPLATE_BYTES = 131_072;
const PAGE_TEMPLATE_SHA = '74447861b9e7809dbac55efc1cb6b6c6365b2f8ea290679c7493b8f08f56990a';
const ROUTE_TEMPLATE_SHA = '01ee442c7e37226e4721aff08f74f95808ac9c83a277c6c7878104bfe2efc985';
const PAGE_MODULE = 'dist/server/route-modules/pages/module.compiled.js';
const ROUTE_MODULE = 'dist/server/route-modules/app-route/module.compiled.js';
const PAGE_MODULE_SHA = 'b88d690f8f1f34d7458d6f7424dee20aab425252f62f2b60d15740ac0808037f';
const ROUTE_MODULE_SHA = 'aeab4882c08e62a742aa67daa0d4a434b3330f389c38ffdf4262b6143c80b5ed';
const PROTECTED_DEPENDENCIES: ReadonlyMap<string, string> = new Map([
  ['dist/server/route-kind.js', '4dc92760c2e4925613034896faa04c52daaf7a4420d7bcbd6de5214b55d84fea'],
  [
    'dist/server/route-modules/pages/pages-handler.js',
    'b20671fb66060f58b98fe7677adf844d10697a97b463eb2390eb00831500bda1',
  ],
  [PAGE_MODULE, PAGE_MODULE_SHA],
  [ROUTE_MODULE, ROUTE_MODULE_SHA],
]);
const USERLAND_BINDINGS: ReadonlyMap<string, string> = new Map([
  ['_VAR_MODULE_APP', 'VAR_MODULE_APP'],
  ['_VAR_MODULE_DOCUMENT', 'VAR_MODULE_DOCUMENT'],
  ['_VAR_USERLAND', 'VAR_USERLAND'],
]);
type Kind = 'pages' | 'app-route';
export interface NodeManifestTemplateImport {
  readonly specifier: string;
  readonly file: string;
  readonly sha256: string;
}
export interface NodeManifestTemplateInput {
  readonly source: { readonly code: string; readonly sha256: string };
  /** All static imports, resolved through the original physical/module-id graph. */
  readonly imports: readonly NodeManifestTemplateImport[];
  readonly route: { readonly kind: Kind; readonly page: string; readonly pathname: string };
}
export interface NodeManifestTemplateProof {
  readonly kind: Kind;
  readonly page: string;
  readonly pathname: string;
  readonly exports: readonly string[];
  readonly requiresRuntimeNormalization: true;
}
interface Template {
  readonly file: string;
  readonly root: string;
  readonly code: string;
}
interface CanonicalContext {
  readonly expected: boolean;
  readonly template: Template;
  readonly input: NodeManifestTemplateInput;
  readonly visits: ReadonlyMap<Node, Visit>;
  readonly replacements: ReadonlyMap<string, string>;
  readonly constructorValues: ReadonlyMap<string, Node>;
}
function refuse(reason: string): never {
  throw new AuditError(`Unproved Next.js route template ${reason}; refusing native publication`);
}
function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
async function templateOf(input: NodeManifestTemplateInput): Promise<Template> {
  const relative = input.route.kind === 'pages' ? PAGE_MODULE : ROUTE_MODULE;
  const expected = input.route.kind === 'pages' ? PAGE_MODULE_SHA : ROUTE_MODULE_SHA;
  const classes = input.imports.filter((entry) =>
    entry.file.replaceAll('\\', '/').endsWith(`/${relative}`),
  );
  const module = classes[0];
  if (module === undefined || classes.length !== 1 || module.sha256 !== expected)
    refuse('constructor identity');
  const root = module.file.slice(0, -relative.length - 1);
  const file = await realpath(path.join(root, 'dist/build/templates', `${input.route.kind}.js`));
  if (beneath(root, file) === undefined) refuse('template source path');
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_TEMPLATE_BYTES) refuse('template source bounds');
  const bytes = await readFile(file);
  const expectedTemplate = input.route.kind === 'pages' ? PAGE_TEMPLATE_SHA : ROUTE_TEMPLATE_SHA;
  if (bytes.length !== info.size || digest(bytes) !== expectedTemplate)
    refuse('template source identity');
  return { file, root, code: bytes.toString('utf8') };
}
function ancestors(visit: Visit, context: CanonicalContext): readonly Node[] {
  const parents: Node[] = [];
  let parent = visit.parent;
  while (parent !== undefined) {
    parents.push(parent);
    parent = context.visits.get(parent)?.parent;
  }
  return parents;
}
function userlandSlot(node: Node, context: CanonicalContext): string | undefined {
  const visit = context.visits.get(node);
  if (visit === undefined) return undefined;
  for (const parent of ancestors(visit, context)) {
    if (parent.type === 'VariableDeclarator' && identifier(parent['id'])) {
      const slot = USERLAND_BINDINGS.get(parent['id'].name);
      if (slot !== undefined) return slot;
    }
    if (
      parent.type === 'Property' &&
      ['getUserland', 'userland'].includes(propertyName(parent) ?? '')
    )
      return 'VAR_USERLAND';
  }
  return undefined;
}
function canonicalNextImport(
  file: string,
  sha256: string | undefined,
  context: CanonicalContext,
): string {
  const relative = beneath(context.template.root, file)?.split(path.sep).join('/');
  if (relative === undefined) return refuse('external framework dependency');
  const expected = PROTECTED_DEPENDENCIES.get(relative);
  if (expected !== undefined && sha256 !== expected && !context.expected)
    refuse('changed protected dependency');
  return `next:${relative}`;
}
function importToken(node: Node, context: CanonicalContext): string | undefined {
  if (
    node.type !== 'CallExpression' ||
    !identifier(node['callee']) ||
    node['callee'].name !== 'require'
  )
    return undefined;
  const args = listOf(node, 'arguments');
  const specifier = stringOf(args[0]);
  if (specifier === undefined || args.length !== 1) return refuse('nonstatic template import');
  if (context.expected) {
    if (specifier.startsWith('VAR_')) return `slot:${specifier}`;
    const file = createRequire(context.template.file).resolve(specifier);
    return canonicalNextImport(file, undefined, context);
  }
  const imports = context.input.imports.filter((entry) => entry.specifier === specifier);
  const imported = imports[0];
  if (imported === undefined || imports.length !== 1)
    return refuse('missing or ambiguous resolved template import');
  if (beneath(context.template.root, imported.file) !== undefined)
    return canonicalNextImport(imported.file, imported.sha256, context);
  const slot = userlandSlot(node, context);
  return slot === undefined ? refuse('unreviewed external template import') : `slot:${slot}`;
}
function fieldsOf(value: unknown): ReadonlyMap<string, Node> {
  if (!isNode(value) || value.type !== 'ObjectExpression') return refuse('constructor fields');
  const fields = new Map<string, Node>();
  for (const property of listOf(value, 'properties')) {
    if (!isNode(property) || property.type !== 'Property') continue;
    const name = propertyName(property);
    if (name === undefined || fields.has(name) || !isNode(property['value']))
      refuse('constructor fields');
    fields.set(name, property['value']);
  }
  return fields;
}
function constructorFields(
  program: Node,
  input: NodeManifestTemplateInput,
): ReadonlyMap<string, Node> {
  const name = input.route.kind === 'pages' ? 'PagesRouteModule' : 'AppRouteRouteModule';
  const constructors = visitTree(program).filter((visit) => {
    const callee = visit.node['callee'];
    return (
      visit.node.type === 'NewExpression' &&
      isNode(callee) &&
      callee.type === 'MemberExpression' &&
      propertyName(callee) === name
    );
  });
  const constructor = constructors[0];
  if (constructor === undefined || constructors.length !== 1) return refuse('route constructor');
  return fieldsOf(listOf(constructor.node, 'arguments')[0]);
}
function generatedValues(
  fields: ReadonlyMap<string, Node>,
  input: NodeManifestTemplateInput,
): ReadonlyMap<string, string> {
  const replacements = new Map([
    ['VAR_DEFINITION_PAGE', input.route.page],
    ['VAR_DEFINITION_PATHNAME', input.route.pathname],
  ]);
  if (input.route.kind === 'pages') return replacements;
  const definition = fieldsOf(fields.get('definition'));
  for (const [placeholder, value] of [
    ['VAR_DEFINITION_FILENAME', definition.get('filename')],
    ['VAR_DEFINITION_BUNDLE_PATH', definition.get('bundlePath')],
    ['VAR_RESOLVED_PAGE_PATH', fields.get('resolvedPagePath')],
  ] as const) {
    const text = stringOf(value);
    if (text === undefined) refuse('opaque app-route diagnostic field');
    // These fixed-template fields never determine loadManifests' distDir/page arguments.
    replacements.set(placeholder, text);
  }
  return replacements;
}
function staticConstructorValues(fields: ReadonlyMap<string, Node>): ReadonlyMap<string, Node> {
  const values = new Map<string, Node>();
  for (const key of ['distDir', 'relativeProjectDir']) {
    const value = fields.get(key);
    // The exact template's environment expression is otherwise compared unchanged. A build-
    // substituted literal is safe only because the enclosing proof obliges SDK normalization.
    if (stringOf(value) !== undefined && isNode(value)) values.set(key, value);
  }
  return values;
}
function injectedOutput(actual: Node, expected: Node): Node {
  const declarations = listOf(actual, 'body').filter((statement) => {
    return (
      isNode(statement) &&
      statement.type === 'VariableDeclaration' &&
      listOf(statement, 'declarations').some((item) => isNode(item) && identifier(item['id']) && item['id'].name === 'nextConfigOutput')
    );
  });
  if (declarations.length === 0) return expected;
  if (declarations.length !== 1 || !isNode(declarations[0])) return refuse('output declaration');
  const statement = declarations[0];
  const variables = listOf(statement, 'declarations');
  const variable = variables[0];
  if (variables.length !== 1 || !isNode(variable)) return refuse('output declaration');
  const value = variable['init'];
  if (
    !(identifier(value) && value.name === 'undefined') &&
    !['export', 'standalone'].includes(stringOf(value) ?? '')
  )
    return refuse('opaque output declaration');
  const body = listOf(expected, 'body');
  const index = body.findIndex((candidate) => {
    return (
      isNode(candidate) &&
      candidate.type === 'VariableDeclaration' &&
      listOf(candidate, 'declarations').some((item) => isNode(item) && identifier(item['id']) && item['id'].name === 'routeModule')
    );
  });
  if (index === -1) return refuse('output template position');
  return { ...expected, body: [...body.slice(0, index), statement, ...body.slice(index)] };
}
function constructorReplacement(
  value: Record<string, unknown>,
  context: CanonicalContext,
): { value: Record<string, unknown>; context: CanonicalContext } {
  const field = isNode(value) && value.type === 'Property' ? propertyName(value) : undefined;
  const replacement = field === undefined ? undefined : context.constructorValues.get(field);
  if (replacement === undefined || !context.expected) return { value, context };
  return {
    value: { ...value, value: replacement },
    context: { ...context, constructorValues: new Map() },
  };
}

function recordShape(value: Record<string, unknown>, context: CanonicalContext): unknown {
  const normalized: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [key, item] of entries) {
    if (['end', 'raw', 'start'].includes(key)) continue;
    normalized[key] =
      key === 'value' && typeof item === 'string' && context.expected
        ? (context.replacements.get(item) ?? item)
        : shape(item, context);
  }
  return normalized;
}

function shape(value: unknown, context: CanonicalContext): unknown {
  if (Array.isArray(value)) return value.map((item) => shape(item, context));
  if (!record(value)) return value;
  const replaced = constructorReplacement(value, context);
  if (isNode(replaced.value)) {
    const imported = importToken(replaced.value, replaced.context);
    if (imported !== undefined) return { type: 'StaticTemplateImport', value: imported };
  }
  return recordShape(replaced.value, replaced.context);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function programOf(code: string): Node {
  const parsed: unknown = parseAst(code);
  if (!isNode(parsed)) return refuse('program');
  return parsed;
}
function contextOf(
  program: Node,
  input: NodeManifestTemplateInput,
  template: Template,
  options: Pick<CanonicalContext, 'expected' | 'replacements' | 'constructorValues'>,
): CanonicalContext {
  return {
    input,
    template,
    ...options,
    visits: new Map(visitTree(program).map((visit) => [visit.node, visit])),
  };
}
/** Exact fixed-template structure; no arbitrary RouteModule constructor or handler is trusted. */
export async function assertNodeManifestTemplateConsumer(
  input: NodeManifestTemplateInput,
): Promise<NodeManifestTemplateProof> {
  if (digest(input.source.code) !== input.source.sha256) refuse('original source digest');
  const template = await templateOf(input);
  const actual = programOf(input.source.code);
  const expected = injectedOutput(actual, programOf(template.code));
  const fields = constructorFields(actual, input);
  const replacements = generatedValues(fields, input);
  const constructorValues = staticConstructorValues(fields);
  const actualShape = shape(
    actual,
    contextOf(actual, input, template, { expected: false, replacements, constructorValues }),
  );
  const expectedShape = shape(
    expected,
    contextOf(expected, input, template, { expected: true, replacements, constructorValues }),
  );
  if (JSON.stringify(actualShape) !== JSON.stringify(expectedShape))
    refuse('template structure or protected export escape');
  return {
    kind: input.route.kind,
    page: input.route.page,
    pathname: input.route.pathname,
    exports:
      input.route.kind === 'pages'
        ? ['routeModule', 'handler']
        : [
            'routeModule',
            'handler',
            'patchFetch',
            'serverHooks',
            'workAsyncStorage',
            'workUnitAsyncStorage',
          ],
    requiresRuntimeNormalization: true,
  };
}
