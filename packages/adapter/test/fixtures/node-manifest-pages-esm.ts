import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAst } from 'rolldown/parseAst';

import { jsLiteral } from '../../src/codegen.ts';
import { isNode, listOf } from '../../src/lexical-scope.ts';
import type { NodeManifestTemplateImport } from '../../src/node-manifest-templates.ts';
import type { NodeManifestTurbopackTemplateInput } from '../../src/node-manifest-turbopack-templates.ts';
import { projectNodeManifestTurbopackFactory } from '../../src/node-manifest-turbopack.ts';

const EXPORTS = [
  'getStaticProps',
  'getStaticPaths',
  'getServerSideProps',
  'config',
  'reportWebVitals',
  'unstable_getStaticProps',
  'unstable_getStaticPaths',
  'unstable_getStaticParams',
  'unstable_getServerProps',
  'unstable_getServerSideProps',
  'routeModule',
  'handler',
];
const PORTS = [
  ['../../server/route-modules/pages/module.compiled', 'moduleNs'],
  ['../../server/route-kind', 'kindNs'],
  ['./helpers', 'helperNs'],
  ['VAR_MODULE_DOCUMENT', 'document'],
  ['VAR_MODULE_APP', 'app'],
  ['VAR_USERLAND', 'userland'],
  ['../../server/route-modules/pages/pages-handler', 'handlerNs'],
] as const;
function source(code: string) {
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}
/** Independently authored compiler-shaped text; no fixture module is executed. */
export async function pagesEsmFixture(
  options: {
    readonly kind?: 'var' | 'let' | 'const';
    readonly grouped?: boolean;
    readonly namespaceMethod?: 'i' | 'r';
    readonly eager?: boolean;
  } = {},
): Promise<
  Omit<NodeManifestTurbopackTemplateInput, 'imports'> & {
    readonly imports: readonly NodeManifestTemplateImport[];
  }
> {
  const anchor = await realpath(
    fileURLToPath(import.meta.resolve('next/dist/build/templates/pages.js')),
  );
  const root = path.resolve(path.dirname(anchor), '../../..');
  const primary = await readFile(path.join(root, 'dist/esm/build/templates/pages.js'), 'utf8');
  const parsed: unknown = parseAst(primary);
  if (!isNode(parsed)) throw new Error('Expected inert ESM primary');
  const first = listOf(parsed, 'body').find(
    (node) => isNode(node) && node.type !== 'ImportDeclaration',
  );
  if (!isNode(first)) throw new Error('Expected primary template body');
  const kind = options.kind ?? 'var';
  const imports: NodeManifestTemplateImport[] = [];
  const prefix: string[] = [];
  let id = 100;
  for (const [specifier, name] of PORTS) {
    if (specifier.startsWith('VAR_')) {
      const target = `turbopack:${id}`;
      imports.push({
        specifier: target,
        file: `/authored/${specifier}.js`,
        sha256: source(specifier).sha256,
      });
      prefix.push(`${name}=context.${options.namespaceMethod ?? 'i'}(${id})`);
      id += 1;
    } else {
      const file = await realpath(createRequire(anchor).resolve(specifier));
      imports.push({ specifier, file, sha256: source(await readFile(file, 'utf8')).sha256 });
      prefix.push(
        `${name}=context.x(${jsLiteral(specifier)},()=>require(${jsLiteral(specifier)}))`,
      );
    }
  }
  let body = primary
    .slice(first.start)
    .replaceAll('VAR_DEFINITION_PAGE', '/blog/[slug]')
    .replaceAll('VAR_DEFINITION_PATHNAME', '/blog/[slug]')
    .replace('export default ', () => `${kind} defaultValue=`)
    .replaceAll('export const ', () => `${kind} `)
    .replaceAll('new PagesRouteModule(', 'new moduleNs.PagesRouteModule(')
    .replaceAll('RouteKind.PAGES', 'kindNs.RouteKind.PAGES')
    .replaceAll('hoist(', '(0,helperNs.hoist)(')
    .replaceAll('getHandler(', '(0,handlerNs.getHandler)(');
  if (options.grouped) body = body.replaceAll(`;\n${kind} `, ',');
  const values = [
    ['default', 'defaultValue'] as const,
    ...EXPORTS.map((name) => [name, name] as const),
  ];
  const table = values
    .map(([name, value]) => {
      const selector = options.eager ? `0,${value}` : `()=>${value}`;
      return `${jsLiteral(name)},${selector}`;
    })
    .join(',');
  const header = `${kind} ${prefix.join(',')};`;
  const registration = `context.s([${table}]);`;
  const code = `module.exports=[1,context=>{"use strict";${options.eager ? '' : registration}${header}${body}\n${options.eager ? registration : ''}}];`;
  return {
    projection: projectNodeManifestTurbopackFactory(source(code), 1),
    imports,
    route: { kind: 'pages', page: '/blog/[slug]', pathname: '/blog/[slug]' },
  };
}

export function mutatePagesEsmFixture(
  input: NodeManifestTurbopackTemplateInput,
  before: string,
  after: string,
): NodeManifestTurbopackTemplateInput {
  const code = input.projection.original.code.replace(before, () => after);
  if (code === input.projection.original.code) throw new Error('Expected authored mutation');
  return { ...input, projection: projectNodeManifestTurbopackFactory(source(code), 1) };
}
