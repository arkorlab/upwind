import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAst } from 'rolldown/parseAst';

import { appEntrySource } from '../../src/app-entry.ts';
import { isNode, listOf } from '../../src/lexical-scope.ts';
import { stringOf, visitTree } from '../../src/node-manifest-consumer-ast.ts';
function digest(code: string | Uint8Array): string {
  return createHash('sha256').update(code).digest('hex');
}
async function templateGraphFixture(directory: string, kind: 'pages' | 'app-route') {
  const evaluatorName = 'dist/server/load-manifest.external.js';
  const published = await realpath(fileURLToPath(import.meta.resolve(`next/${evaluatorName}`)));
  const publishedRoot = path.resolve(path.dirname(published), '../..');
  const root = path.join(directory, 'node_modules/next');
  const module = `dist/server/route-modules/${kind}/module.compiled.js`;
  const runtime = `dist/compiled/next-server/${kind}.runtime.prod.js`;
  const template = `dist/build/templates/${kind}.js`;
  const sources = new Map<string, { file: string; sha256: string }>();
  async function copy(relative: string): Promise<string> {
    const bytes = await readFile(path.join(publishedRoot, relative));
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    sources.set(file, { file, sha256: digest(bytes) });
    return file;
  }
  const evaluator = await copy(evaluatorName);
  const compiled = await copy(runtime);
  const constructor = await copy(module);
  const templateFile = await copy(template);
  await writeFile(path.join(root, 'package.json'), '{"name":"next","version":"16.4.3"}');
  const distDir = path.join(directory, '.next');
  const route =
    kind === 'pages'
      ? { id: '/blog/[slug]', page: '/blog/[slug]', relative: 'server/pages/blog/[slug].js' }
      : { id: '/stream', page: '/stream/route', relative: 'server/app/stream/route.js' };
  const entry = path.join(distDir, route.relative);
  const code = (await readFile(templateFile, 'utf8'))
    .replaceAll('VAR_DEFINITION_PAGE', () => route.page)
    .replaceAll('VAR_DEFINITION_PATHNAME', () => route.id)
    .replaceAll('VAR_DEFINITION_FILENAME', 'route')
    .replaceAll('VAR_DEFINITION_BUNDLE_PATH', 'app/stream/route')
    .replaceAll('VAR_RESOLVED_PAGE_PATH', '/project/app/stream/route.ts');
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, code);
  sources.set(entry, { file: entry, sha256: digest(code) });
  const imported: { specifier: string; target: string }[] = [];
  const program: unknown = parseAst(code);
  if (!isNode(program)) throw new Error('Expected an inert published template program');
  for (const visit of visitTree(program)) {
    const node = visit.node;
    if (
      node.type !== 'CallExpression' ||
      !isNode(node['callee']) ||
      node['callee']['name'] !== 'require'
    )
      continue;
    const specifier = stringOf(listOf(node, 'arguments')[0]);
    if (specifier === undefined || imported.some((item) => item.specifier === specifier)) continue;
    let target: string;
    if (specifier.startsWith('VAR_')) {
      target = path.join(directory, `${specifier}.js`);
      await writeFile(target, 'module.exports={};');
      sources.set(target, { file: target, sha256: digest('module.exports={};') });
    } else {
      const originalTemplate = path.join(publishedRoot, template);
      const resolved = createRequire(originalTemplate).resolve(specifier);
      const relative = path.relative(publishedRoot, resolved);
      target = await copy(relative);
    }
    imported.push({ specifier, target });
  }
  const entries = [{ id: route.id, filePath: entry }];
  const analysisEntry = path.join(directory, 'entry.cjs');
  const rootCode = appEntrySource(entries, {
    external: true,
    runtimeDistDir: distDir,
    nodeRequestMeta: true,
  });
  await writeFile(analysisEntry, rootCode);
  sources.set(analysisEntry, { file: analysisEntry, sha256: digest(rootCode) });
  const importers = new Map([
    [analysisEntry, []],
    [compiled, [constructor]],
    [constructor, [entry]],
    [entry, [analysisEntry]],
    [evaluator, [compiled]],
  ]);
  const imports = new Map([
    [analysisEntry, [{ specifier: entry, target: entry }]],
    [compiled, [{ specifier: 'next/dist/server/load-manifest.external.js', target: evaluator }]],
    [constructor, [{ specifier: `next/${runtime}`, target: compiled }]],
    [entry, imported],
  ]);
  return {
    entry,
    code,
    route,
    input: {
      distDir,
      entries,
      analysisEntry,
      manifests: [],
      entryTraces: [],
      runtimeManifest: JSON.stringify({
        entrypoints: [{ id: route.id, pathname: route.id, kind }],
      }),
    },
    graph: {
      sources,
      imports,
      importers,
      roots: new Set([analysisEntry]),
      retained: new Set(sources.keys()),
    },
  };
}

export async function nodeManifestTemplateGraphFixture(
  directory: string,
  kind: 'pages' | 'app-route',
): Promise<Awaited<ReturnType<typeof templateGraphFixture>>> {
  return templateGraphFixture(directory, kind);
}
