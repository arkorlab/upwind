import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { parseAst } from 'rolldown/parseAst';

import { jsLiteral } from './codegen.ts';
import { AuditError } from './dependencies.ts';
import { childrenOf, isNode, listOf, type Node } from './lexical-scope.ts';
import { type Patch, Rewrite } from './patches/types.ts';

// Native Functions deliberately do not implement application-supplied cache handlers. Keep
// this Node policy in the physical runtime too: an unexpected router-context override must
// fail here rather than invoke a loader that the original-source analysis did not inspect.
const TARGET =
  // eslint-disable-next-line require-unicode-regexp -- Rolldown's filter uses Go regular expressions.
  /next-server\/(?:app-page|app-route|pages|pages-api)(?:-turbo)?(?:-experimental)?\.runtime\.prod\.js$/;
const HANDLERS_IMPORT =
  // eslint-disable-next-line sonarjs/super-linear-regex -- Applied once to separately byte-certified Next.js sources.
  /[\w$]+\(await [\w$]+\([\w$]+\(`\$\{[\w$]+\}\/\$\{this\.distDir\}`,[\w$]+\)\)\)/gu;
const HANDLER_IMPORT =
  // eslint-disable-next-line sonarjs/super-linear-regex -- As above.
  /[\w$]+\(await [\w$]+\([\w$]+\(this\.distDir,[\w$]+\)\)\)/gu;
const MAX_CONFIG_BYTES = 33_554_432;

function unsupported(option: string): string {
  const message = jsLiteral(
    `@stayingupwind/adapter: ${option} is unsupported in native Node Functions`,
  );
  return `(()=>{throw new Error(${message})})()`;
}

/** A shared-cache policy guard, independent of every Worker loader replacement. */
export const nodeCachePolicyPatch: Patch = {
  name: 'node-custom-cache-policy',
  target: TARGET,
  reaches: ['server-runtime'],
  apply(source, file) {
    const result = new Rewrite('node-custom-cache-policy', file, source)
      .replace(HANDLERS_IMPORT, unsupported('cacheHandlers'), 1, 'custom kind handler import')
      .replace(HANDLER_IMPORT, unsupported('cacheHandler'), 1, 'custom incremental handler import');
    return { contents: result.contents, edits: result.edits, notes: ['Node custom-cache guard'] };
  },
};

function refuse(reason: string): never {
  throw new AuditError(`Native Node custom-cache policy ${reason}; refusing native publication`);
}

interface RemovedRange {
  readonly start: number;
  readonly end: number;
}

function removedRange(source: string, pattern: RegExp): RemovedRange {
  pattern.lastIndex = 0;
  const matches = [...source.matchAll(pattern)];
  const match = matches[0];
  if (match === undefined || matches.length !== 1) refuse('import edit bounds');
  return Object.freeze({ start: match.index, end: match.index + match[0].length });
}

/** Original-offset DATA from the same two physical policy patterns; not rewrite authority. */
export function nodeCachePolicyRemovedRanges(source: string): readonly RemovedRange[] {
  const ranges = [
    removedRange(source, HANDLERS_IMPORT),
    removedRange(source, HANDLER_IMPORT),
  ].toSorted((left, right) => left.start - right.start);
  const first = ranges[0];
  const second = ranges[1];
  if (first === undefined || second === undefined || first.end > second.start)
    refuse('overlapping import edit bounds');
  return Object.freeze(ranges);
}

function assertObjectKeys(node: Node): void {
  if (node.type !== 'ObjectExpression') return;
  const names = new Set<string>();
  for (const property of listOf(node, 'properties')) {
    if (!isNode(property) || !isNode(property['key'])) refuse('configuration property');
    const key = property['key']['value'];
    if (typeof key !== 'string' || names.has(key)) refuse('duplicate configuration key');
    names.add(key);
  }
}
function childNodes(node: Node): Node[] {
  return childrenOf(node).flatMap((child) => {
    const values: unknown[] = Array.isArray(child) ? child : [child];
    return values.filter((value) => isNode(value));
  });
}
function assertUniqueKeys(code: string): void {
  const parsed: unknown = parseAst(`(${code});`);
  if (!isNode(parsed)) refuse('configuration syntax');
  const pending: Node[] = [parsed];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    assertObjectKeys(node);
    for (const child of childNodes(node)) pending.push(child);
  }
}

function assertNoConfiguredHandlers(code: string): void {
  const parsed: unknown = JSON.parse(code);
  assertUniqueKeys(code);
  if (typeof parsed !== 'object' || parsed === null || !('config' in parsed))
    refuse('missing recorded configuration');
  const config = parsed.config;
  if (typeof config !== 'object' || config === null || Array.isArray(config))
    refuse('invalid recorded configuration');
  if ('cacheHandler' in config && Boolean(config.cacheHandler))
    refuse('does not support a configured cacheHandler');
  if (!('cacheHandlers' in config)) return;
  const handlers = config.cacheHandlers;
  const configured = Boolean(handlers);
  if (!configured) return;
  if (handlers === null || typeof handlers !== 'object' || Array.isArray(handlers))
    refuse('invalid recorded cacheHandlers');
  if (Object.values(handlers).some(Boolean)) refuse('does not support configured cacheHandlers');
}

/** Seal inert build configuration; runtime overrides encounter the physical Node guard. */
export async function nodeCachePolicyConfig(distDir: string): Promise<{
  readonly file: string;
  readonly sha256: string;
}> {
  const file = path.join(distDir, 'required-server-files.json');
  const info = await lstat(file);
  if (!info.isFile() || info.size > MAX_CONFIG_BYTES || (await realpath(file)) !== file)
    refuse('configuration physical source');
  const bytes = await readFile(file);
  const code = bytes.toString('utf8');
  if (bytes.length !== info.size || !bytes.equals(Buffer.from(code)))
    refuse('configuration changed or has invalid encoding');
  try {
    assertNoConfiguredHandlers(code);
  } catch (error) {
    if (error instanceof AuditError) throw error;
    refuse('configuration data');
  }
  return Object.freeze({ file, sha256: createHash('sha256').update(bytes).digest('hex') });
}
