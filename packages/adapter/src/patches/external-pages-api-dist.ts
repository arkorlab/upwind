import path from 'node:path';

import { buildPaths } from '../build-paths.ts';
import { jsLiteral } from '../codegen.ts';
import { AuditError } from '../dependencies.ts';
import { type Patch, Rewrite } from './types.ts';

/**
 * Next.js 16.4.2's Pages API template keeps its routeModule private, unlike Pages and App routes
 * (`next/src/build/templates/pages-api.ts`). A generated entry cannot normalize that instance.
 * Its compiled base constructor receives the physical relative distDir, so change that one
 * initializer at build time for an external output. There is no request-time wrapper or lookup.
 */
export const EXTERNAL_PAGES_API_DIST_PATCH = 'external-pages-api-dist';
const TARGET =
  // eslint-disable-next-line require-unicode-regexp -- a bundler filter: a Go regular expression.
  /next-server\/pages-api(?:-turbo)?(?:-experimental)?\.runtime\.prod\.js$/;
const CONSTRUCTOR_DIST = /this\.distDir=[\w$]+,this\.relativeProjectDir=(?<project>[\w$]+)/gu;

export const externalPagesApiDistPatch: Patch = {
  name: EXTERNAL_PAGES_API_DIST_PATCH,
  target: TARGET,
  externalOutputOnly: true,
  reaches: ['server-runtime'],
  apply(source, file, ctx) {
    const paths = buildPaths(ctx.projectDir, ctx.distDir);
    if (!paths.external) return { contents: source, edits: 0, notes: [] };
    const result = new Rewrite(EXTERNAL_PAGES_API_DIST_PATCH, file, source)
      .expand(
        CONSTRUCTOR_DIST,
        `this.distDir=${jsLiteral(paths.runtimeDistDir)},this.relativeProjectDir=$<project>`,
        1,
        'the private Pages API route constructor distDir',
      )
      .forbid([CONSTRUCTOR_DIST], 'an unnormalized Pages API route constructor');
    return { contents: result.contents, edits: result.edits, notes: [] };
  },
};

/** A moved runtime must fail the build instead of leaving an external Pages API to fail at HTTP. */
export function auditExternalPagesApiDist(
  projectDir: string,
  distDir: string,
  entries: readonly { readonly filePath: string }[],
  applied: readonly { readonly patch: string }[],
): void {
  if (!buildPaths(projectDir, distDir).external) return;
  const pages = path.join(distDir, 'server', 'pages');
  const hasApi = entries.some((entry) => {
    const relative = path.relative(pages, entry.filePath).split(path.sep).join('/');
    return relative === 'api.js' || relative.startsWith('api/');
  });
  if (hasApi && applied.every((patch) => patch.patch !== EXTERNAL_PAGES_API_DIST_PATCH)) {
    throw new AuditError(
      '@stayingupwind/adapter: external Pages API output bundled no private route constructor to normalize',
    );
  }
}
