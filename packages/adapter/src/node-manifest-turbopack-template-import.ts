import { AuditError } from './dependencies.ts';
import { manifestConstructorImport } from './node-manifest-framework.ts';
import {
  nodeManifestPagesConjunctionIdentity,
  type NodeManifestPagesConjunctionImport,
} from './node-manifest-pages-conjunction-walk.ts';
import type { NodeManifestTemplateHelperOwner } from './node-manifest-template-helpers.ts';
import type { NodeManifestTemplateImport } from './node-manifest-templates.ts';
import type { NodeManifestTurbopackProjection } from './node-manifest-turbopack.ts';

/** A logical all-member constructor port is never a single physical import descriptor. */
export type NodeManifestTurbopackTemplateImport =
  | NodeManifestTemplateImport
  | NodeManifestPagesConjunctionImport;
interface Context {
  readonly route: { readonly kind: string };
  readonly helperOwner?: NodeManifestTemplateHelperOwner | undefined;
  readonly projection: NodeManifestTurbopackProjection;
}
function refuse(reason: string): never {
  throw new AuditError(`Unproved Pages conjunction ${reason}; refusing native publication`);
}
export function nodeManifestTurbopackConstructorIdentity(
  imported: NodeManifestTurbopackTemplateImport,
  input: Context,
): { readonly root: string; readonly module: string } | undefined {
  if ('file' in imported) return manifestConstructorImport(imported.file, imported.sha256);
  if (input.route.kind !== 'pages') return refuse('grouped constructor used outside Pages');
  return nodeManifestPagesConjunctionIdentity(imported, {
    owner: input.helperOwner,
    projection: input.projection,
  });
}
export function nodeManifestPagesConjunctionToken(
  imported: NodeManifestPagesConjunctionImport,
  input: Context,
  root: string,
): string {
  const identity = nodeManifestTurbopackConstructorIdentity(imported, input);
  if (
    identity?.root !== root ||
    identity.module !== 'dist/server/route-modules/pages/module.compiled.js'
  )
    return refuse('grouped constructor profile');
  return `next:${identity.module}`;
}
