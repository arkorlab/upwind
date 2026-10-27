import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';

import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';
import { isNode, type Node } from './lexical-scope.ts';
import { declaration, visitTree } from './node-manifest-consumer-ast.ts';
import { reviewedFrameworkSource } from './node-manifest-framework.ts';
import type { ManifestModuleGraph, ManifestRouteSource } from './node-manifest-graph.ts';
import { originalNodeSpecifierInventory } from './node-source-specifiers.ts';
import type { Patch } from './patches/types.ts';

const TOKEN = 'process.env.TURBOPACK';
const APP_SELECTOR_READS = 4;
const PAGES_SELECTOR_READS = 2;
const TARGET =
  // eslint-disable-next-line require-unicode-regexp -- Rolldown's filter uses Go regular expressions.
  /\/next\/dist\/server\/route-modules\/(?:app-page|app-route|pages-api|pages)\/module\.compiled\.js$/;
const SELECTORS: ReadonlyMap<string, number> = new Map([
  ['dist/server/route-modules/app-page/module.compiled.js', APP_SELECTOR_READS],
  ['dist/server/route-modules/app-route/module.compiled.js', APP_SELECTOR_READS],
  ['dist/server/route-modules/pages-api/module.compiled.js', PAGES_SELECTOR_READS],
  ['dist/server/route-modules/pages/module.compiled.js', PAGES_SELECTOR_READS],
]);

interface SelectorTargetsInput {
  readonly selector: ManifestRouteSource;
  readonly analysis: string;
  readonly id: string;
  readonly graph: Pick<ManifestModuleGraph, 'sources' | 'retained' | 'imports' | 'rendered'>;
  readonly routes: ReadonlyMap<string, ManifestRouteSource>;
}

interface PolicySourcePin {
  readonly file: string;
  readonly sha256: string;
}
/** Copy/dedup DATA only; source-role approval belongs to the existing private certificate. */
export function nodeNextPolicySourcePins(
  groups: readonly Iterable<PolicySourcePin>[],
): readonly PolicySourcePin[] {
  const sources = new Map<string, PolicySourcePin>();
  for (const group of groups) {
    for (const source of group) {
      const previous = sources.get(source.file);
      if (previous !== undefined && previous.sha256 !== source.sha256)
        throw new AuditError(
          'Unproved Node Next.js rewrite conflicting physical policy source pins; refusing native publication',
        );
      sources.set(source.file, Object.freeze({ file: source.file, sha256: source.sha256 }));
    }
  }
  return Object.freeze([...sources.values()]);
}

function expectedTarget(selector: ManifestRouteSource, specifier: string): string | undefined {
  let file: string | undefined;
  if (specifier.startsWith('next/'))
    file = path.resolve(selector.root, specifier.slice('next/'.length));
  else if (specifier.startsWith('.')) file = path.resolve(path.dirname(selector.file), specifier);
  if (file === undefined) return undefined;
  const relative = path.relative(selector.root, file).split(path.sep).join('/');
  const kind = path.posix.basename(path.posix.dirname(selector.relative));
  const prefix = `dist/compiled/next-server/${kind}-turbo`;
  return [`${prefix}-experimental.runtime.prod.js`, `${prefix}.runtime.prod.js`].includes(relative)
    ? relative
    : undefined;
}

function targetMatches(input: SelectorTargetsInput, target: string, relative: string): boolean {
  const source = input.graph.sources.get(target);
  const approved = source === undefined ? undefined : input.routes.get(source.file);
  return (
    input.graph.retained.has(target) &&
    input.graph.rendered?.has(target) === true &&
    source !== undefined &&
    approved?.root === input.selector.root &&
    approved.relative === relative &&
    approved.file === source.file &&
    approved.sha256 === source.sha256 &&
    source.file === path.resolve(input.selector.root, relative)
  );
}

/** Target-membership DATA only; callers still need the completed opaque route/caller proof. */
export function nativeTurbopackSelectorTargets(
  applied: { readonly file: string; readonly result: { readonly contents: string } },
  graph: SelectorTargetsInput['graph'],
  routes: SelectorTargetsInput['routes'],
): boolean {
  const own = graph.sources.get(applied.file);
  const selector = own === undefined ? undefined : routes.get(own.file);
  if (
    selector === undefined ||
    selector.sha256 !== own?.sha256 ||
    !graph.retained.has(applied.file) ||
    !SELECTORS.has(selector.relative) ||
    path.resolve(selector.root) !== selector.root ||
    path.resolve(selector.root, selector.relative) !== selector.file
  )
    return false;
  const input = { selector, graph, routes, id: applied.file, analysis: applied.result.contents };
  const loads = originalNodeSpecifierInventory(
    selector.file,
    new TextEncoder().encode(input.analysis),
  ).required;
  const edges = graph.imports?.get(applied.file);
  if (edges === undefined || loads.length === 0) return false;
  return loads.every((load) => {
    const relative = expectedTarget(selector, load.specifier);
    const targets = edges.filter((edge) => edge.specifier === load.specifier);
    return (
      load.kind === 'require' &&
      relative !== undefined &&
      targets.length > 0 &&
      targets.every((edge) => targetMatches(input, edge.target, relative))
    );
  });
}

function coordinate(file: string): readonly [string, number] | undefined {
  if (!path.isAbsolute(file) || path.normalize(file) !== file || file.includes('\0'))
    return undefined;
  const normalized = file.split(path.sep).join('/');
  return [...SELECTORS].find(([relative]) => normalized.endsWith(`/${relative}`));
}

function canonical(file: string): boolean {
  try {
    return realpathSync(file) === file;
  } catch {
    return false;
  }
}

function selectorReads(code: string): readonly Node[] {
  const program: unknown = parseAst(code, { sourceType: 'commonjs' });
  if (!isNode(program)) return [];
  return visitTree(program)
    .filter(({ node, parent, key, scopes }) => {
      return (
        node.type === 'MemberExpression' &&
        parent?.type === 'IfStatement' &&
        key === 'test' &&
        code.slice(node.start, node.end) === TOKEN &&
        declaration('process', scopes) === undefined
      );
    })
    .map(({ node }) => node);
}

/**
 * Native rendering policy for four whole-source-pinned Next 16.4.3 selectors.
 * Only a separate completed route/caller rewrite certificate can authorize its physical replay.
 * Unknown source stays unchanged here; this helper alone never grants a loader or source role.
 */
export function nativeTurbopackSelectorSource(file: string, code: string): string {
  const selected = coordinate(file);
  if (selected === undefined) return code;
  const [relative, expected] = selected;
  if (createHash('sha256').update(code).digest('hex') !== reviewedFrameworkSource(relative))
    return code;
  if (!canonical(file)) return code;
  const reads = selectorReads(code);
  if (reads.length !== expected)
    throw new AuditError('Pinned Next.js Turbopack selector has unexpected condition reads');
  let result = code;
  const descending = reads.toSorted((left, right) => right.start - left.start);
  for (const read of descending)
    result = `${result.slice(0, read.start)}"1"${result.slice(read.end)}`;
  return result;
}

/** Analysis and physical artifacts choose the same backend, without a global environment define. */
export const nativeTurbopackSelectorPatch: Patch = {
  name: 'node-turbopack-selector-policy',
  target: TARGET,
  reaches: ['module'],
  apply(source, file) {
    const contents = nativeTurbopackSelectorSource(file, source);
    const edits = contents === source ? 0 : coordinate(file)?.[1];
    if (edits === undefined)
      throw new AuditError('Pinned Next.js Turbopack selector lost its coordinate');
    return { contents, edits, notes: ['Native Turbopack selector policy'] };
  },
};
