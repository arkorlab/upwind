import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { parseAst } from 'rolldown/parseAst';

import { beneath } from './build-paths.ts';
import { AuditError } from './dependencies.ts';
import { isNode, listOf } from './lexical-scope.ts';
import { stringOf } from './node-manifest-consumer-ast.ts';
import type { NodeManifestNormalization } from './node-manifest-normalization.ts';

const MAX_MANIFEST_BYTES = 4_194_304;
const MAX_PATH_CHARACTERS = 4096;
const DEFINITION = Symbol('canonical Pages definition');
export interface NodeManifestPagesDefinition {
  readonly [DEFINITION]: true;
  readonly file: string;
  readonly page: string;
  readonly pathname: string;
}
interface DefinitionSource {
  readonly file: string;
  readonly sha256: string;
}
interface StoredDefinition {
  readonly pages: ReadonlySet<string>;
}
const DEFINITIONS = new WeakMap<NodeManifestPagesDefinition, StoredDefinition>();

function refuse(reason: string): never {
  throw new AuditError(`Unproved canonical Pages ${reason}; refusing native publication`);
}
function safePath(value: string, absolute: boolean): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_PATH_CHARACTERS ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.startsWith('/') !== absolute
  )
    return false;
  const pieces = (absolute ? value.slice(1) : value).split('/');
  return value === '/' || pieces.every((piece) => piece !== '' && piece !== '.' && piece !== '..');
}
function normalPage(pathname: string): string {
  // Fixed normalize-page-path.ts: escape a literal /index prefix, except dynamic routes.
  const dynamic = pathname
    .split('/')
    .some((segment) => segment.length > 2 && segment.startsWith('[') && segment.endsWith(']'));
  if (!dynamic && /^\/index(?:\/|$)/u.test(pathname)) return `/index${pathname}`;
  return pathname === '/' ? '/index' : pathname;
}
function definition(file: string, pathname: string): NodeManifestPagesDefinition {
  const page = normalPage(pathname);
  const value: NodeManifestPagesDefinition = Object.freeze({
    [DEFINITION]: true,
    file,
    page,
    pathname,
  });
  // Webpack normalizes page; Turbopack preserves the source's optional trailing /index.
  const pages = new Set([
    `${pathname === '/' ? '' : pathname}/index`,
    page,
    pathname === '/' ? '/index' : pathname,
  ]);
  DEFINITIONS.set(value, { pages });
  return value;
}

/** Only a manifest-minted definition may select the fixed template's source-page scalar. */
export function nodeManifestPagesPage(
  route: {
    readonly page: string;
    readonly pathname: string;
    readonly definition?: NodeManifestPagesDefinition | undefined;
  },
  actual: unknown,
): string {
  if (route.definition === undefined) return route.page;
  const stored = DEFINITIONS.get(route.definition);
  const page = stringOf(actual);
  if (
    page === undefined ||
    stored === undefined ||
    route.definition.page !== route.page ||
    route.definition.pathname !== route.pathname ||
    !stored.pages.has(page)
  )
    return refuse('template definition scalar');
  return page;
}

function manifestRows(code: string): readonly (readonly [string, string])[] {
  let json: unknown;
  try {
    json = JSON.parse(code);
  } catch {
    return refuse('manifest JSON');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) refuse('manifest object');
  const parsed: unknown = parseAst(`(${code});`);
  if (!isNode(parsed)) return refuse('manifest syntax');
  const statement = listOf(parsed, 'body')[0];
  if (!isNode(statement) || !isNode(statement['expression'])) return refuse('manifest syntax');
  const expression = statement['expression'];
  if (expression.type !== 'ObjectExpression') return refuse('manifest object');
  const names = new Set<string>();
  const rows: [string, string][] = [];
  for (const property of listOf(expression, 'properties')) {
    if (!isNode(property)) refuse('manifest property');
    const name = stringOf(property['key']);
    const file = stringOf(property['value']);
    if (name === undefined || file === undefined || names.has(name))
      refuse('duplicate or invalid manifest row');
    if (!safePath(name, true) || !safePath(file, false)) refuse('manifest path');
    names.add(name);
    rows.push([name, file]);
  }
  return rows;
}
async function manifestSource(
  dist: string,
): Promise<{ source: DefinitionSource; rows: readonly (readonly [string, string])[] } | undefined> {
  const file = path.join(dist, 'server', 'pages-manifest.json');
  let info: Stats;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (!info.isFile() || info.size > MAX_MANIFEST_BYTES || (await realpath(file)) !== file)
    refuse('manifest physical source');
  const bytes = await readFile(file);
  if (bytes.length !== info.size) refuse('manifest changed while reading');
  const code = bytes.toString('utf8');
  if (!bytes.equals(Buffer.from(code))) refuse('manifest encoding');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { source: Object.freeze({ file, sha256 }), rows: manifestRows(code) };
}

/** Compiler metadata annotates existing owned Pages files; it never creates executable entries. */
export async function nodeManifestPagesDefinitions(
  normalization: NodeManifestNormalization,
  ownedPages: ReadonlySet<string>,
): Promise<{
  readonly definitions: ReadonlyMap<string, NodeManifestPagesDefinition>;
  readonly files: readonly DefinitionSource[];
}> {
  const definitions = new Map<string, NodeManifestPagesDefinition>();
  if (ownedPages.size === 0) return { definitions, files: [] };
  const manifest = await manifestSource(normalization.canonicalDistDir);
  if (manifest === undefined) return { definitions, files: [] };
  const server = path.join(normalization.canonicalDistDir, 'server');
  const pages = path.join(server, 'pages');
  const physical = new Set<string>();
  for (const [pathname, relative] of manifest.rows) {
    if (!relative.endsWith('.js')) continue;
    const declared = path.join(server, relative);
    const file = await realpath(declared);
    if (file !== declared || beneath(pages, file) === undefined || !(await lstat(file)).isFile())
      refuse('manifest target');
    if (physical.has(file)) refuse('ambiguous physical definition');
    physical.add(file);
    if (ownedPages.has(file)) definitions.set(file, definition(file, pathname));
  }
  for (const file of ownedPages) if (!definitions.has(file)) refuse('missing physical definition');
  return { definitions, files: Object.freeze([manifest.source]) };
}
