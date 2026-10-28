import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseAst } from 'rolldown/parseAst';

import { beneath } from './build-paths.ts';
import { AuditError } from './dependencies.ts';
import { isNode, type Node } from './lexical-scope.ts';
import type { NodeManifestAlpha } from './node-manifest-alpha.ts';
import { nodeManifestPagesEsmExpectedCode } from './node-manifest-pages-esm-ports.ts';
import type { ManifestTemplateExports } from './node-manifest-template-exports.ts';

const MAX_TEMPLATE_BYTES = 131_072;
const PINS = {
  anchor: [
    'dist/build/templates/pages.js',
    '74447861b9e7809dbac55efc1cb6b6c6365b2f8ea290679c7493b8f08f56990a',
  ],
  source: [
    'dist/esm/build/templates/pages.js',
    '75a1371817e5bbc8df736b1b32cc988e36ffdb005d5ebcf665eea0fdce78c86f',
  ],
  loader: [
    'dist/build/load-entrypoint.js',
    '7b7ef4b888ba375811fd1cc368292d93974d9c908334dfc460833cf7a30acc3d',
  ],
} as const;
function refuse(reason: string): never {
  throw new AuditError(
    `Unproved Next.js Pages ESM template ${reason}; refusing native publication`,
  );
}
function invalidExport(reason: string): never {
  throw new AuditError(
    `Unproved Next.js Turbopack route template ${reason}; refusing native publication`,
  );
}
/** The unchanged source digest shared by both pinned template profiles. */
export function nodeManifestTemplateDigest(code: string | Uint8Array): string {
  return createHash('sha256').update(code).digest('hex');
}
/** Unchanged parser shared by the physical and template inspection views. */
export function nodeManifestTemplateProgram(code: string): Node {
  const value: unknown = parseAst(code);
  if (!isNode(value)) return invalidExport('program');
  return value;
}
async function pinned(root: string, pin: readonly [string, string]): Promise<string> {
  const file = path.join(root, pin[0]);
  if (beneath(root, file) !== pin[0].split('/').join(path.sep) || (await realpath(file)) !== file)
    return refuse('pinned source path');
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_TEMPLATE_BYTES) return refuse('pinned source bounds');
  const bytes = await readFile(file);
  if (bytes.length !== info.size || nodeManifestTemplateDigest(bytes) !== pin[1])
    return refuse('pinned source bytes');
  return bytes.toString('utf8');
}

/** Fixed public ESM producer DATA; the actual constructor/helper graph must still close. */
export async function nodeManifestPagesEsmTemplate(root: string): Promise<{
  readonly file: string;
  readonly root: string;
  readonly program: Node;
  readonly esm: true;
}> {
  if (!path.isAbsolute(root) || (await realpath(root)) !== root)
    return refuse('canonical Next root');
  // loadEntrypoint reads the ESM body but expands it against this exact CJS source anchor.
  await pinned(root, PINS.loader);
  await pinned(root, PINS.anchor);
  const code = await pinned(root, PINS.source);
  const value: unknown = parseAst(nodeManifestPagesEsmExpectedCode(code));
  if (!isNode(value) || value.type !== 'Program') return refuse('expected inspection program');
  return { file: path.join(root, PINS.anchor[0]), root, program: value, esm: true };
}

/** The existing export-selector guard is shared by both exact template profiles. */
export function nodeManifestTemplateExportNames(
  actual: { readonly alpha: NodeManifestAlpha; readonly exports: ManifestTemplateExports },
  expected: { readonly alpha: NodeManifestAlpha; readonly exports: ManifestTemplateExports },
  kind: 'pages' | 'pages-api' | 'app-route',
): readonly string[] {
  const mandatory = kind === 'pages-api' ? ['handler'] : ['routeModule', 'handler'];
  for (const required of mandatory)
    if (!actual.exports.fields.has(required)) invalidExport('missing protected export');
  for (const [name, selector] of actual.exports.fields) {
    const known = expected.exports.fields.get(name);
    if (
      known === undefined ||
      JSON.stringify(actual.alpha.shape(selector)) !== JSON.stringify(expected.alpha.shape(known))
    )
      invalidExport('changed protected export selector');
  }
  return [...actual.exports.fields.keys()];
}
