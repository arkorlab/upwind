import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  assertNodeManifestTemplateConsumer,
  type NodeManifestTemplateInput,
} from '../src/node-manifest-templates.ts';

const PAGES_IMPORTS = [
  '../../server/route-modules/pages/module.compiled',
  '../../server/route-kind',
  './helpers',
  'VAR_MODULE_DOCUMENT',
  'VAR_MODULE_APP',
  'VAR_USERLAND',
  '../../server/route-modules/pages/pages-handler',
];
const ROUTE_IMPORTS = [
  '../../server/route-modules/app-route/module.compiled',
  '../../server/route-kind',
  '../../server/lib/patch-fetch',
  '../../server/request-meta',
  '../../server/lib/trace/tracer',
  '../../server/app-render/manifests-singleton',
  '../../shared/lib/router/utils/app-paths',
  '../../server/base-http/node',
  '../../server/web/spec-extension/adapters/next-request',
  '../../server/lib/trace/constants',
  '../../server/instrumentation/utils',
  '../../server/send-response',
  '../../server/web/utils',
  '../../server/lib/cache-control',
  '../../lib/constants',
  '../../shared/lib/no-fallback-error.external',
  '../../server/lib/route-cache-key',
  '../../server/response-cache',
  'VAR_USERLAND',
];
function digest(code: string | Uint8Array): string {
  return createHash('sha256').update(code).digest('hex');
}
function source(code: string): { code: string; sha256: string } {
  return { code, sha256: digest(code) };
}
async function input(kind: 'pages' | 'app-route'): Promise<NodeManifestTemplateInput> {
  const file = await realpath(
    fileURLToPath(import.meta.resolve(`next/dist/build/templates/${kind}.js`)),
  );
  const imports = [];
  const specifiers = kind === 'pages' ? PAGES_IMPORTS : ROUTE_IMPORTS;
  for (const specifier of specifiers) {
    if (specifier.startsWith('VAR_')) {
      imports.push({ specifier, file: `/project/${specifier}.js`, sha256: digest(specifier) });
      continue;
    }
    const dependency = await realpath(createRequire(file).resolve(specifier));
    imports.push({ specifier, file: dependency, sha256: digest(await readFile(dependency)) });
  }
  const route =
    kind === 'pages'
      ? { kind, page: '/blog/[slug]', pathname: '/blog/[slug]' }
      : { kind, page: '/stream/route', pathname: '/stream' };
  const code = (await readFile(file, 'utf8'))
    .replaceAll('VAR_DEFINITION_PAGE', () => route.page)
    .replaceAll('VAR_DEFINITION_PATHNAME', () => route.pathname)
    .replaceAll('VAR_DEFINITION_FILENAME', 'route')
    .replaceAll('VAR_DEFINITION_BUNDLE_PATH', 'app/stream/route')
    .replaceAll('VAR_RESOLVED_PAGE_PATH', '/project/app/stream/route.ts');
  return { source: source(code), imports, route };
}

const REFUSAL_REPLACEMENTS = {
  route: ["page: '/blog/[slug]'", "page: '/other'"],
  constructor: ['new _modulecompiled.PagesRouteModule', 'new _modulecompiled.OtherRouteModule'],
  'export-helper': ['_export(exports, {', '_export = function() {};\n_export(exports, {'],
  'export-escape': ['const handler =', 'exports.escaped=routeModule;\nconst handler ='],
  'dist-expression': ["distDir: process.env.__NEXT_RELATIVE_DIST_DIR || ''", 'distDir: userInput()'],
  'handler-mutation': ['const handler =', 'routeModule.loadManifests(userInput(), userInput());\nconst handler ='],
  'handler-alias': ['const handler =', 'exports.class=_modulecompiled.PagesRouteModule;\nconst handler ='],
  digest: ['const handler =', 'const handler ='],
} as const;

function changedInput(
  own: NodeManifestTemplateInput,
  scenario: keyof typeof REFUSAL_REPLACEMENTS,
): NodeManifestTemplateInput {
  const [original, replacement] = REFUSAL_REPLACEMENTS[scenario];
  const code = own.source.code.replace(original, () => replacement);
  const candidate = { ...own, source: source(code) };
  if (scenario === 'digest') candidate.source.sha256 = digest('other bytes');
  return candidate;
}

describe('finite original Next.js route template consumers', () => {
  it.each(['pages', 'app-route'] as const)(
    'certifies the actual published %s constructor, handler and export scaffold',
    async (kind) => {
      const own = await input(kind);
      const proof = await assertNodeManifestTemplateConsumer(own);

      expect(proof.kind).toBe(kind);
      expect([proof.page, proof.pathname]).toStrictEqual([own.route.page, own.route.pathname]);
      expect(proof.exports).toContain('routeModule');
      expect(proof.requiresRuntimeNormalization).toBe(true);
    },
  );

  it('accepts only finite build literals before obliging SDK AppRoute normalization', async () => {
    const own = await input('app-route');
    const code = own.source.code
      .replace(
        'const routeModule = new',
        'const nextConfigOutput = undefined;\nconst routeModule = new',
      )
      .replace("distDir: process.env.__NEXT_RELATIVE_DIST_DIR || ''", "distDir: '.next'");
    const proof = await assertNodeManifestTemplateConsumer({ ...own, source: source(code) });

    expect(proof.exports).toContain('routeModule');
    expect(proof.requiresRuntimeNormalization).toBe(true);
  });

  it('uses actual resolved import identities instead of trusting import spellings', async () => {
    const own = await input('pages');
    const changed = '../../server/route-modules/pages/module.compiled';
    const code = own.source.code.replace(changed, 'sealed:pages-constructor');
    const imports = own.imports.map((entry) => {
      return entry.specifier === changed
        ? { ...entry, specifier: 'sealed:pages-constructor' }
        : entry;
    });

    await expect(
      assertNodeManifestTemplateConsumer({ ...own, source: source(code), imports }),
    ).resolves.toMatchObject({ kind: 'pages', pathname: '/blog/[slug]' });
  });

  it.each([
    'route',
    'constructor',
    'export-helper',
    'export-escape',
    'dist-expression',
    'handler-mutation',
    'handler-alias',
    'digest',
  ] as const)('refuses an unproved %s even with a reviewed class dependency', async (scenario) => {
    const own = await input('pages');
    const candidate = changedInput(own, scenario);

    await expect(assertNodeManifestTemplateConsumer(candidate)).rejects.toThrow(
      'Unproved Next.js route template',
    );
  });

  it('refuses changed handler bytes or an unresolved private class alias', async () => {
    const own = await input('pages');
    const imports = own.imports.map((entry) => {
      return entry.specifier.endsWith('/pages-handler')
        ? { ...entry, sha256: digest('changed') }
        : entry;
    });
    const missing = own.imports.filter((entry) => !entry.specifier.endsWith('/module.compiled'));

    await expect(assertNodeManifestTemplateConsumer({ ...own, imports })).rejects.toThrow(
      'changed protected dependency',
    );
    await expect(assertNodeManifestTemplateConsumer({ ...own, imports: missing })).rejects.toThrow(
      'constructor identity',
    );
  });

  it('does not certify a PagesAPI handler whose private routeModule cannot be normalized by the SDK entry', async () => {
    const own = await input('pages');
    const api = fileURLToPath(import.meta.resolve('next/dist/build/templates/pages-api.js'));
    const code = await readFile(api, 'utf8');

    await expect(
      assertNodeManifestTemplateConsumer({ ...own, source: source(code) }),
    ).rejects.toThrow('route constructor');
  });
});
