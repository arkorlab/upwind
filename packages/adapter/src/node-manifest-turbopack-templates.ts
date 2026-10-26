import { readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { beneath } from './build-paths.ts';
import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node } from './lexical-scope.ts';
import { NodeManifestAlpha } from './node-manifest-alpha.ts';
import {
  nodeManifestCoalescedPagesInspection,
  type NodeManifestCoalescedPagesProfile,
} from './node-manifest-coalesced-pages.ts';
import {
  declaration,
  identifier,
  propertyName,
  stringOf,
  visitTree,
  type Visit,
} from './node-manifest-consumer-ast.ts';
import { reviewedRouteConstructorSource } from './node-manifest-framework.ts';
import {
  nodeManifestPagesPage,
  type NodeManifestPagesDefinition,
} from './node-manifest-pages-definitions.ts';
import { assertNodeManifestPagesEsmPorts } from './node-manifest-pages-esm-ports.ts';
import {
  nodeManifestPagesEsmTemplate,
  nodeManifestTemplateDigest as digest,
  nodeManifestTemplateExportNames,
  nodeManifestTemplateProgram as program,
} from './node-manifest-pages-esm.ts';
import { nodeManifestTemplateDeclarationView } from './node-manifest-template-declarations.ts';
import {
  projectedTemplateExports,
  swcTemplateExports,
  type ManifestTemplateExports,
} from './node-manifest-template-exports.ts';
import {
  currentTemplateHelperImport,
  nodeManifestTemplateHelperToken,
} from './node-manifest-template-helper-tokens.ts';
import type { NodeManifestTemplateHelperOwner } from './node-manifest-template-helpers.ts';
import {
  nodeManifestTemplateConstructors,
  nodeManifestTemplateMemberName,
} from './node-manifest-template-members.ts';
import type { NodeManifestTemplateProof } from './node-manifest-templates.ts';
import type { NodeManifestTurbopackConsumerInput } from './node-manifest-turbopack-consumers.ts';
import {
  nodeManifestTurbopackConstructorIdentity,
  nodeManifestPagesConjunctionToken,
  type NodeManifestTurbopackTemplateImport,
} from './node-manifest-turbopack-template-import.ts';
import { assertStrictFactory, withoutStrict } from './node-manifest-turbopack-template-strict.ts';
import {
  projectNodeManifestTurbopackFactory,
  type NodeManifestTurbopackProjection,
} from './node-manifest-turbopack.ts';

const MAX_TEMPLATE_BYTES = 131_072;
const PROFILES = {
  pages: {
    constructorName: 'PagesRouteModule',
    module: 'dist/server/route-modules/pages/module.compiled.js',
    moduleSha: 'b88d690f8f1f34d7458d6f7424dee20aab425252f62f2b60d15740ac0808037f',
    templateSha: '74447861b9e7809dbac55efc1cb6b6c6365b2f8ea290679c7493b8f08f56990a',
  },
  'app-route': {
    constructorName: 'AppRouteRouteModule',
    module: 'dist/server/route-modules/app-route/module.compiled.js',
    moduleSha: 'aeab4882c08e62a742aa67daa0d4a434b3330f389c38ffdf4262b6143c80b5ed',
    templateSha: '01ee442c7e37226e4721aff08f74f95808ac9c83a277c6c7878104bfe2efc985',
  },
  'pages-api': {
    constructorName: 'PagesAPIRouteModule',
    module: 'dist/server/route-modules/pages-api/module.compiled.js',
    moduleSha: '0203c76f81559286e5c80c7ef070fe7ceb325a0a7f13528e44e6b6acec208d36',
    templateSha: 'a1943f62ef5d5a7c0093c560600484bd3029c047bd72e83803e36171dc6d8ac0',
  },
} as const;
const PROTECTED_IMPORTS: ReadonlyMap<string, string> = new Map([
  [
    'dist/server/request-meta.js',
    'd91bfe6253f61ada12eb73650589cee8e8cd3eb038c35e0550d242bb6c31803d',
  ],
  ['dist/server/route-kind.js', '4dc92760c2e4925613034896faa04c52daaf7a4420d7bcbd6de5214b55d84fea'],
  [
    'dist/server/route-modules/pages/pages-handler.js',
    'b20671fb66060f58b98fe7677adf844d10697a97b463eb2390eb00831500bda1',
  ],
  [PROFILES.pages.module, PROFILES.pages.moduleSha],
  [PROFILES['app-route'].module, PROFILES['app-route'].moduleSha],
  [PROFILES['pages-api'].module, PROFILES['pages-api'].moduleSha],
]);
export interface NodeManifestTurbopackTemplateInput {
  readonly projection: NodeManifestTurbopackProjection;
  readonly imports: readonly NodeManifestTurbopackTemplateImport[];
  readonly helperOwner?: NodeManifestTemplateHelperOwner | undefined;
  readonly route: {
    readonly kind: keyof typeof PROFILES;
    readonly page: string;
    readonly pathname: string;
    readonly definition?: NodeManifestPagesDefinition | undefined;
  };
  /** Private, original-source-bound inspection only; never a physical source identity. */
  readonly coalesced?: {
    readonly profile: NodeManifestCoalescedPagesProfile;
    readonly owner: NodeManifestTurbopackConsumerInput;
  };
}
interface Template {
  readonly file: string;
  readonly root: string;
  readonly program: Node;
  readonly esm?: true;
}
interface Context {
  readonly program: Node;
  readonly visits: ReadonlyMap<Node, Visit>;
  readonly fields: ReadonlyMap<string, Node>;
  readonly slots: ReadonlyMap<Node, string>;
  readonly template: Template;
  readonly input: NodeManifestTurbopackTemplateInput;
  readonly expected: boolean;
  readonly namespace?: string;
}
function refuse(reason: string): never {
  throw new AuditError(
    `Unproved Next.js Turbopack route template ${reason}; refusing native publication`,
  );
}
function checkedProjection(input: NodeManifestTurbopackTemplateInput): {
  readonly projection: NodeManifestTurbopackProjection;
  readonly namespace?: string;
} {
  if (input.coalesced !== undefined) {
    if (input.route.kind !== 'pages') return refuse('coalesced route kind');
    const derived = nodeManifestCoalescedPagesInspection(
      input.coalesced.profile,
      input.coalesced.owner,
      input.projection,
      { ...input.route, kind: 'pages' },
    );
    return { projection: derived.projection, namespace: derived.namespace };
  }
  const id = input.projection.moduleId;
  const proof = projectNodeManifestTurbopackFactory(input.projection.original, id);
  if (JSON.stringify(proof) !== JSON.stringify(input.projection)) refuse('projection provenance');
  if (proof.boundRuntimeInputs.length > 0) refuse('unmodeled bound runtime input');
  return { projection: proof };
}
async function templateOf(input: NodeManifestTurbopackTemplateInput): Promise<Template> {
  const profile = PROFILES[input.route.kind];
  const imports = input.imports
    .map((entry) => nodeManifestTurbopackConstructorIdentity(entry, input))
    .filter((entry) => entry?.module === profile.module);
  const imported = imports[0];
  if (imported === undefined || imports.length !== 1) refuse('constructor import identity');
  const root = imported.root;
  const file = await realpath(path.join(root, 'dist/build/templates', `${input.route.kind}.js`));
  if (beneath(root, file) === undefined) return refuse('template source path');
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_TEMPLATE_BYTES) return refuse('template source bounds');
  const bytes = await readFile(file);
  if (bytes.length !== info.size || digest(bytes) !== profile.templateSha)
    refuse('template source bytes');
  return { file, root, program: program(bytes.toString('utf8')) };
}
function fieldsOf(value: unknown): ReadonlyMap<string, Node> {
  if (!isNode(value) || value.type !== 'ObjectExpression') return refuse('constructor object');
  const fields = new Map<string, Node>();
  for (const property of listOf(value, 'properties')) {
    if (!isNode(property) || property.type !== 'Property') continue;
    const key = propertyName(property);
    if (key === undefined || fields.has(key) || !isNode(property['value']))
      return refuse('constructor fields');
    fields.set(key, property['value']);
  }
  return fields;
}
function constructorFields(
  value: Node,
  input: NodeManifestTurbopackTemplateInput,
): ReadonlyMap<string, Node> {
  const constructors = nodeManifestTemplateConstructors(
    value,
    PROFILES[input.route.kind].constructorName,
  );
  const constructor = constructors[0];
  if (constructor === undefined || constructors.length !== 1) return refuse('constructor');
  return fieldsOf(listOf(constructor, 'arguments')[0]);
}
function origin(value: unknown, visits: ReadonlyMap<Node, Visit>): Node | undefined {
  if (!identifier(value)) return undefined;
  const visit = visits.get(value);
  return visit === undefined ? undefined : declaration(value.name, visit.scopes)?.node;
}
function slotBindings(
  fields: ReadonlyMap<string, Node>,
  visits: ReadonlyMap<Node, Visit>,
): ReadonlyMap<Node, string> {
  const slots = new Map<Node, string>();
  const userland = origin(fields.get('userland'), visits);
  if (userland !== undefined) slots.set(userland, 'VAR_USERLAND');
  const components = fields.get('components');
  if (components !== undefined) {
    for (const [field, slot] of [
      ['App', 'VAR_MODULE_APP'],
      ['Document', 'VAR_MODULE_DOCUMENT'],
    ] as const) {
      const value = fieldsOf(components).get(field);
      const object =
        isNode(value) && value.type === 'MemberExpression' ? value['object'] : undefined;
      const binding = origin(object, visits);
      if (binding === undefined || slots.has(binding))
        return refuse('component namespace identity');
      slots.set(binding, slot);
    }
  }
  return slots;
}
function contextOf(
  value: Node,
  template: Template,
  input: NodeManifestTurbopackTemplateInput,
  options: { readonly expected: boolean; readonly namespace?: string },
): Context {
  const visits = new Map(visitTree(value).map((visit) => [visit.node, visit]));
  const fields = constructorFields(value, input);
  return {
    program: value,
    template,
    input,
    expected: options.expected,
    ...(options.namespace !== undefined && { namespace: options.namespace }),
    visits,
    fields,
    slots: slotBindings(fields, visits),
  };
}
function slotOf(node: Node, context: Context): string | undefined {
  let parent = context.visits.get(node)?.parent;
  while (parent !== undefined) {
    const slot = context.slots.get(parent);
    if (slot !== undefined) return slot;
    if (
      parent.type === 'Property' &&
      ['getUserland', 'userland'].includes(propertyName(parent) ?? '')
    )
      return 'VAR_USERLAND';
    parent = context.visits.get(parent)?.parent;
  }
  return undefined;
}
function nextToken(file: string, sha256: string | undefined, context: Context): string {
  const relative = beneath(context.template.root, file)?.split(path.sep).join('/');
  if (relative === undefined) return refuse('framework namespace path');
  const constructor =
    sha256 === undefined ? undefined : reviewedRouteConstructorSource(relative, sha256);
  if (constructor !== undefined) {
    if (constructor.module !== PROFILES[context.input.route.kind].module)
      refuse('constructor profile');
    return `next:${constructor.module}`;
  }
  const expected = PROTECTED_IMPORTS.get(relative);
  if (expected !== undefined && sha256 !== expected && !context.expected)
    refuse('changed protected import');
  return `next:${relative}`;
}
function namespaceToken(node: Node, context: Context): string | undefined {
  if (context.namespace !== undefined) {
    if (
      !context.expected &&
      identifier(node) &&
      node.name === context.namespace &&
      origin(node, context.visits) === undefined
    )
      return 'slot:VAR_USERLAND';
    const parent = context.visits.get(node)?.parent;
    if (
      context.expected &&
      parent?.type === 'VariableDeclarator' &&
      parent['init'] === node &&
      context.slots.get(parent) === 'VAR_USERLAND'
    )
      return 'slot:VAR_USERLAND';
  }
  return undefined;
}
function importToken(node: Node, context: Context): string | undefined {
  const helper =
    context.input.route.kind === 'pages'
      ? nodeManifestTemplateHelperToken(node, {
          program: context.program,
          visits: context.visits,
          imports: context.input.imports,
          templateFile: context.template.file,
          nextRoot: context.template.root,
          expected: context.expected,
          owner: context.input.helperOwner,
          projection: context.input.projection,
        })
      : undefined;
  if (helper !== undefined) return helper;
  const namespace = namespaceToken(node, context);
  if (namespace !== undefined) return namespace;
  if (
    node.type !== 'CallExpression' ||
    !identifier(node['callee']) ||
    node['callee'].name !== 'require'
  )
    return undefined;
  const args = listOf(node, 'arguments');
  const specifier = stringOf(args[0]);
  if (specifier === undefined || args.length !== 1) return refuse('dynamic template import');
  if (context.expected) {
    if (specifier.startsWith('VAR_')) return `slot:${specifier}`;
    return nextToken(createRequire(context.template.file).resolve(specifier), undefined, context);
  }
  const imports = context.input.imports.filter((entry) => entry.specifier === specifier);
  const imported = imports[0];
  if (imported === undefined || imports.length !== 1) return refuse('unresolved import');
  if ('conjunction' in imported)
    return nodeManifestPagesConjunctionToken(imported, context.input, context.template.root);
  if (
    !currentTemplateHelperImport(imported, {
      owner: context.input.helperOwner,
      projection: context.input.projection,
    })
  )
    refuse('changed template helper import');
  if (beneath(context.template.root, imported.file) !== undefined)
    return nextToken(imported.file, imported.sha256, context);
  const slot = slotOf(node, context);
  if (slot === undefined) {
    const projection = context.input.projection;
    refuse(
      `unrecognized external import; registration ${projection.original.sha256}:${projection.factory.start}-${projection.factory.end}; inspection ${node.start}-${node.end}`,
    );
  }
  return `slot:${slot}`;
}
function outputDeclaration(actual: Context, expected: Node): Node {
  if (actual.input.route.kind !== 'app-route') return expected;
  const output = actual.fields.get('nextConfigOutput');
  if (!identifier(output)) return expected;
  const binding = origin(output, actual.visits);
  if (binding === undefined) return expected;
  if (binding.type !== 'VariableDeclarator') return refuse('output binding');
  const value = binding['init'];
  const globalUndefined =
    identifier(value) && value.name === 'undefined' && origin(value, actual.visits) === undefined;
  if (!globalUndefined && !['export', 'standalone'].includes(stringOf(value) ?? ''))
    return refuse('opaque output value');
  const declaratorStatement = actual.visits.get(binding)?.parent;
  if (
    declaratorStatement?.type !== 'VariableDeclaration' ||
    listOf(declaratorStatement, 'declarations').length !== 1
  )
    return refuse('output declaration');
  const own = {
    ...declaratorStatement,
    declarations: [{ ...binding, id: { ...output, name: 'nextConfigOutput' } }],
  };
  const body = listOf(expected, 'body');
  const index = body.findIndex((statement) => {
    return (
      isNode(statement) &&
      statement.type === 'VariableDeclaration' &&
      listOf(statement, 'declarations').some(
        (node) => isNode(node) && identifier(node['id']) && node['id'].name === 'routeModule',
      )
    );
  });
  if (index === -1) return refuse('output template position');
  return { ...expected, body: [...body.slice(0, index), own, ...body.slice(index)] };
}
function constructorScalar(value: Node, actual: Context): Node | undefined {
  if (value.type !== 'Property') return undefined;
  const name = propertyName(value);
  const selected = name === undefined ? undefined : actual.fields.get(name);
  if (['distDir', 'relativeProjectDir'].includes(name ?? '') && stringOf(selected) !== undefined)
    return { ...value, value: selected };
  if (
    name !== 'nextConfigOutput' ||
    selected === undefined ||
    origin(selected, actual.visits) !== undefined
  )
    return undefined;
  const empty = identifier(selected) && selected.name === 'undefined';
  if (!empty && !['export', 'standalone'].includes(stringOf(selected) ?? ''))
    return refuse('opaque inline output');
  return { ...value, value: selected };
}
function templatePage(actual: Context): string {
  if (actual.input.route.kind !== 'pages') {
    if (actual.input.route.definition !== undefined)
      refuse('canonical Pages definition used for another kind');
    return actual.input.route.page;
  }
  return nodeManifestPagesPage(
    actual.input.route,
    fieldsOf(actual.fields.get('definition')).get('page'),
  );
}
function expectedScalars(template: Template, actual: Context): Template {
  const replacements = new Map<string, string>([
    ['VAR_DEFINITION_PAGE', templatePage(actual)],
    ['VAR_DEFINITION_PATHNAME', actual.input.route.pathname],
  ]);
  if (actual.input.route.kind === 'app-route') {
    const definition = fieldsOf(actual.fields.get('definition'));
    for (const [name, value] of [
      ['VAR_DEFINITION_FILENAME', definition.get('filename')],
      ['VAR_DEFINITION_BUNDLE_PATH', definition.get('bundlePath')],
      ['VAR_RESOLVED_PAGE_PATH', actual.fields.get('resolvedPagePath')],
    ] as const) {
      const text = stringOf(value);
      if (text === undefined) return refuse('opaque diagnostic field');
      replacements.set(name, text);
    }
  }
  const expected = outputDeclaration(actual, template.program);
  function replace(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => replace(item));
    if (typeof value !== 'object' || value === null) return value;
    if (isNode(value)) {
      if (value.type === 'Literal' && typeof value['value'] === 'string')
        return { ...value, value: replacements.get(value['value']) ?? value['value'] };
      const selected = constructorScalar(value, actual);
      if (selected !== undefined) return selected;
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]));
  }
  const replaced = replace(expected);
  if (!isNode(replaced)) return refuse('expected program');
  return { ...template, program: replaced };
}
function view(
  context: Context,
  projection?: NodeManifestTurbopackProjection,
): { readonly alpha: NodeManifestAlpha; readonly exports: ManifestTemplateExports } {
  const exports =
    projection?.exports.kind === 'getters'
      ? projectedTemplateExports(context.program)
      : swcTemplateExports(context.program);
  const body = withoutStrict(exports.body);
  const alpha = new NodeManifestAlpha({
    original: context.program,
    body: context.template.esm
      ? nodeManifestTemplateDeclarationView({ original: context.program, body })
      : body,
    importToken: (node) => importToken(node, context),
    memberName: nodeManifestTemplateMemberName,
  });
  return { alpha, exports };
}
/** Inspection only: alpha/scaffold views never replace original runtime or application bytes. */
export async function assertNodeManifestTurbopackTemplateConsumer(
  input: NodeManifestTurbopackTemplateInput,
): Promise<NodeManifestTemplateProof> {
  assertStrictFactory(input.projection);
  const checked = checkedProjection(input);
  const projection = checked.projection;
  const primary = await templateOf(input);
  const options = checked.namespace === undefined ? {} : { namespace: checked.namespace };
  const actual = contextOf(program(projection.source.code), primary, input, {
    ...options,
    expected: false,
  });
  const template = expectedScalars(primary, actual);
  const expected = contextOf(template.program, template, input, { ...options, expected: true });
  const actualView = view(actual, projection);
  const expectedView = view(expected);
  let exports: readonly string[];
  if (JSON.stringify(actualView.alpha.body()) === JSON.stringify(expectedView.alpha.body()))
    exports = nodeManifestTemplateExportNames(actualView, expectedView, input.route.kind);
  else if (input.route.kind === 'pages') {
    const esm = expectedScalars(await nodeManifestPagesEsmTemplate(primary.root), actual);
    assertNodeManifestPagesEsmPorts({
      program: actual.program,
      original: input,
      slots: actual.slots,
      ...options,
    });
    const left = view({ ...actual, template: esm }, projection);
    const right = view(contextOf(esm.program, esm, input, { ...options, expected: true }));
    if (JSON.stringify(left.alpha.body()) !== JSON.stringify(right.alpha.body()))
      refuse('changed ESM handler or constructor body');
    exports = nodeManifestTemplateExportNames(left, right, input.route.kind);
  } else refuse('changed handler or constructor body');
  return {
    kind: input.route.kind,
    page: templatePage(actual),
    pathname: input.route.pathname,
    exports,
    requiresRuntimeNormalization: true,
  };
}
