import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { WorkerFunctionSpec as FunctionSpec } from '@stayingupwind/core/bundle';
import { describe, expect, it } from 'vitest';

import { deploymentFunctions, type DeploymentFunctions } from '../src/functions.ts';

type FunctionModule = FunctionSpec['modules'][number];

const DEPLOYMENT_ID = 'dpl_4Fixture2Minima1AppXy';
const BINDINGS = {
  text: [
    { name: 'APP_SETTING', value: 'the application’s', secret: false },
    { name: 'ARKOR_CACHE_TOKEN', value: 'v1.scope.signature', secret: true },
    { name: 'APP_SETTING', value: 'the deployment’s', secret: false },
  ],
  services: [
    { name: 'ARKOR_CACHE', service: 'upwind-cache' },
    {
      name: 'ARKOR_PREFETCH',
      service: 'upwind-prefetch',
      entrypoint: 'PrefetchForDeployment',
      props: { allowedSha256: { ['a'.repeat(64)]: true } },
    },
  ],
};

/** A build's directory, with a `blobs/` for its modules. */
function buildDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'upwind-local-'));
  mkdirSync(path.join(dir, 'blobs'));
  return dir;
}

/** A module of the build: its bytes stored under their digest, as the adapter stores them. */
function module(
  dir: string,
  name: string,
  type: FunctionModule['type'],
  text: string,
): FunctionModule {
  const bytes = Buffer.from(text);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(path.join(dir, 'blobs', sha256), bytes);
  return {
    name,
    type,
    blob: { sha256, byteLength: bytes.byteLength, contentType: 'text/javascript; charset=utf-8' },
  };
}

function spec(modules: FunctionModule[]): FunctionSpec {
  return {
    mainModule: 'index.mjs',
    modules,
    compatibilityDate: '2026-09-15',
    compatibilityFlags: ['nodejs_compat'],
  };
}

describe('the Functions of a deployment, on a local stack', () => {
  it('runs each under its name in the build, its main module first, bound as every one is', () => {
    const dir = buildDir();
    const app = spec([
      module(dir, 'app.cjs', 'commonjs', 'module.exports = 1;'),
      module(dir, 'index.mjs', 'esm', 'export default {};'),
      module(dir, 'wasm', 'data', '\0asm'),
    ]);

    const { app: runtime, workers } = deploymentFunctions(
      dir,
      { deploymentId: DEPLOYMENT_ID, functions: { app } },
      BINDINGS,
    );

    expect(runtime).toStrictEqual({ deploymentId: DEPLOYMENT_ID, scriptName: 'upwind-app' });
    expect(workers.map((worker) => worker.name)).toStrictEqual(['upwind-app']);
    expect(workers[0]?.modules.map((entry) => [entry.name, entry.type])).toStrictEqual([
      ['index.mjs', 'ESModule'],
      ['app.cjs', 'CommonJS'],
      ['wasm', 'Data'],
    ]);
    expect(workers[0]?.modules[2]?.contents).toBeInstanceOf(Uint8Array);
    expect(workers[0]?.bindings).toStrictEqual({
      APP_SETTING: 'the deployment’s',
      ARKOR_CACHE_TOKEN: 'v1.scope.signature',
    });
    expect(workers[0]?.services).toStrictEqual({
      ARKOR_CACHE: 'upwind-cache',
      ARKOR_PREFETCH: {
        name: 'upwind-prefetch',
        entrypoint: 'PrefetchForDeployment',
        props: { allowedSha256: { ['a'.repeat(64)]: true } },
      },
    });
  });

  it('names a split build’s Functions after the first, and the middleware’s, as the pointer will', () => {
    const dir = buildDir();
    const one = spec([module(dir, 'index.mjs', 'esm', 'export default {};')]);

    const { app: runtime, workers } = deploymentFunctions(
      dir,
      {
        deploymentId: DEPLOYMENT_ID,
        functions: { app: one, split: { 'app-3': one, 'app-2': one }, middleware: one },
      },
      BINDINGS,
    );

    expect(runtime).toStrictEqual({
      deploymentId: DEPLOYMENT_ID,
      scriptName: 'upwind-app',
      middlewareScriptName: 'upwind-middleware',
      functions: { 'app-2': 'upwind-app-2', 'app-3': 'upwind-app-3' },
    });
    expect(workers.map((worker) => worker.name)).toStrictEqual([
      'upwind-app',
      'upwind-app-2',
      'upwind-app-3',
      'upwind-middleware',
    ]);
  });

  it('refuses unmatched native Workflow declarations or artifacts before starting Workers', () => {
    const dir = buildDir();
    const app = spec([module(dir, 'index.mjs', 'esm', 'export default { fetch() {} };')]);
    const definition = {
      name: 'JOBS',
      module: 'jobs.ts',
      // eslint-disable-next-line unicorn/no-keyword-prefix -- Matches the host registration field.
      className: 'Job',
    };

    expect(() => {
      return deploymentFunctions(
        dir,
        { deploymentId: DEPLOYMENT_ID, cloudflareWorkflows: [definition], functions: { app } },
        BINDINGS,
      );
    }).toThrow('Cloudflare Workflow registrations and artifacts differ');
    expect(() => {
      return deploymentFunctions(
        dir,
        { deploymentId: DEPLOYMENT_ID, functions: { app, cloudflareWorkflows: { JOBS: app } } },
        BINDINGS,
      );
    }).toThrow('Cloudflare Workflow registrations and artifacts differ');
  });

  it('refuses a module whose bytes are not the blob it names, a build that runs workflows or has Durable Objects, and a missing main module', () => {
    const dir = buildDir();
    const named = module(dir, 'index.mjs', 'esm', 'export default {};');
    // Its last byte changed in place, its length kept: only the digest tells.
    writeFileSync(path.join(dir, 'blobs', named.blob.sha256), 'export default {}:');
    const app = spec([module(dir, 'index.mjs', 'esm', 'export default { fetch() {} };')]);

    expect(() => {
      deploymentFunctions(
        dir,
        { deploymentId: DEPLOYMENT_ID, functions: { app: spec([named]) } },
        BINDINGS,
      );
    }).toThrow(`index.mjs is not the blob its bundle names (${named.blob.sha256})`);
    expect(() => {
      deploymentFunctions(
        dir,
        { deploymentId: DEPLOYMENT_ID, functions: { app, workflow: app } },
        BINDINGS,
      );
    }).toThrow('runs workflows, and a local stack runs no workflow World for it');

    // Its Functions would be served without the namespaces a deploy binds them to.
    const counters = {
      name: 'COUNTERS',
      module: 'objects/counter.ts',
      // eslint-disable-next-line unicorn/no-keyword-prefix -- the declaration's own field.
      className: 'Counter',
    };

    expect(() => {
      deploymentFunctions(
        dir,
        {
          deploymentId: DEPLOYMENT_ID,
          durableObjects: [counters],
          functions: { app, durableObjects: { COUNTERS: app } },
        },
        BINDINGS,
      );
    }).toThrow('has Durable Objects of its own (COUNTERS), and a local stack runs none for it');
    // A main module of none of its modules: another of them would run in its place.
    expect(() => {
      deploymentFunctions(
        dir,
        { deploymentId: DEPLOYMENT_ID, functions: { app: { ...app, mainModule: 'gone.mjs' } } },
        BINDINGS,
      );
    }).toThrow("upwind-app's main module gone.mjs is none of its modules");
  });

  it.each([
    "export default () => import(`./data.json`, { with: { type: 'json' } });",
    "export default () => import('./' + 'data.json', { with: { type: 'json' } });",
    `export default () => import(\`./\${'data'}.json\`, { with: { type: 'json' } });`,
    "import data from './data.json' assert { type: 'json' };",
    "export { default as data } from './data.json' with { type: 'json' };",
    "export * from './data.json' assert { type: 'json' };",
    "export default () => import('./data.json', { assert: { type: 'json' } });",
    "export default () => import('./data.json', { 'with': { 'type': 'json' } });",
  ])('refuses attributed JSON imports and re-exports: %s', (source) => {
    const dir = buildDir();
    const app = spec([
      module(dir, 'index.mjs', 'esm', source),
      module(dir, 'data.json', 'json', '{"value":1}'),
    ]);

    expect(() =>
      deploymentFunctions(dir, { deploymentId: DEPLOYMENT_ID, functions: { app } }, BINDINGS),
    ).toThrow('index.mjs imports ./data.json by the JSON type');
  });

  it.each([
    ["'./data-' + 1 + '.json'", 'data-1.json'],
    [`\`./data-\${1}.json\``, 'data-1.json'],
    [`\`./data-\${true}.json\``, 'data-true.json'],
    [`\`./data-\${null}.json\``, 'data-null.json'],
    [`\`./data-\${1n}.json\``, 'data-1.json'],
    [`\`./data-\${-0}.json\``, 'data-0.json'],
    [`\`./data-\${void 0}.json\``, 'data-undefined.json'],
    ["'./data-' + false + '.json'", 'data-false.json'],
    ["'./data-' + -1 + '.json'", 'data--1.json'],
    ["'./data-' + 1 + 2 + '.json'", 'data-12.json'],
    ["'./data-' + (+'1') + '.json'", 'data-1.json'],
    ["'./data-' + (+'') + '.json'", 'data-0.json'],
  ])('refuses a primitive-folded JSON specifier %s', (specifier, name) => {
    const dir = buildDir();
    const source = `export default () => import(${specifier}, { with: { type: 'json' } });`;
    const app = spec([
      module(dir, 'index.mjs', 'esm', source),
      module(dir, name, 'json', '{"value":1}'),
    ]);

    expect(() => {
      deploymentFunctions(dir, { deploymentId: DEPLOYMENT_ID, functions: { app } }, BINDINGS);
    }).toThrow(`index.mjs imports ./${name} by the JSON type`);
  });

  it.each([
    "1 + 2 + '.json'",
    "'./data-' + (1 + 2) + '.json'",
    "'./data-' + 1.5 + '.json'",
    "'./data-' + (+'x') + '.json'",
    "'./data-' + (+'01') + '.json'",
    "'./data-' + unknown + '.json'",
    "'./data-' + { toString() { throw new Error('must not execute'); } } + '.json'",
  ])('keeps an unresolved or non-string addition unresolved: %s', (specifier) => {
    const dir = buildDir();
    const source = `export default () => import(${specifier}, { with: { type: 'json' } });`;
    const app = spec([
      module(dir, 'index.mjs', 'esm', source),
      ...[
        '3.json',
        '12.json',
        'data-3.json',
        'data-12.json',
        'data-1.5.json',
        'data-NaN.json',
        'data-1.json',
      ].map((name) => module(dir, name, 'json', '{"value":1}')),
    ]);

    expect(
      deploymentFunctions(dir, { deploymentId: DEPLOYMENT_ID, functions: { app } }, BINDINGS)
        .workers,
    ).toHaveLength(1);
  });

  it.each([
    "if (false) return IMPORT; return 'ok';",
    "if (true) return 'ok'; else return IMPORT;",
    "return false ? IMPORT : 'ok';",
    "return true ? 'ok' : IMPORT;",
    'return false && IMPORT;',
    'return true || IMPORT;',
    "return 'ready' ?? IMPORT;",
    'return !true && IMPORT;',
    'return (effect(), false) && IMPORT;',
    "if (flag && false) return IMPORT; return 'ok';",
    "if (flag || true) return 'ok'; else return IMPORT;",
    "if (void effect()) return IMPORT; return 'ok';",
    "if (typeof effect()) return 'ok'; else return IMPORT;",
    "if (0n) return IMPORT; return 'ok';",
    "if (-0) return IMPORT; return 'ok';",
    "if (+0) return IMPORT; return 'ok';",
    "if (/pattern/) return 'ok'; else return IMPORT;",
  ])('keeps provably dead dynamic JSON imports out of the local refusal: %s', (body) => {
    const dir = buildDir();
    const source = `export default function () { ${body.replace('IMPORT', "import('./data.json', { with: { type: 'json' } })")} }`;
    const app = spec([
      module(dir, 'index.mjs', 'esm', source),
      module(dir, 'data.json', 'json', '{"value":1}'),
    ]);

    expect(
      deploymentFunctions(dir, { deploymentId: DEPLOYMENT_ID, functions: { app } }, BINDINGS)
        .workers,
    ).toHaveLength(1);
  });

  it.each([
    "if (true) return IMPORT; return 'ok';",
    "if (flag) return IMPORT; return 'ok';",
    "return flag ? IMPORT : 'ok';",
    'return flag && IMPORT;',
    'return flag || IMPORT;',
    'return flag ?? IMPORT;',
    'return true && IMPORT;',
    'return false || IMPORT;',
    'return null ?? IMPORT;',
    "if (1n) return IMPORT; return 'ok';",
    "if (-1) return IMPORT; return 'ok';",
    "if (/pattern/) return IMPORT; return 'ok';",
    "if (void IMPORT) return 'dead'; return 'ok';",
    "if (typeof IMPORT) return 'ok'; return 'other';",
    "return (IMPORT, false) && 'dead';",
    "return 'ok'; IMPORT;",
    "function unused() { return IMPORT; } return 'ok';",
    'function local(undefined) { return undefined ?? IMPORT; } return local(flag);',
    'function local(NaN) { return NaN && IMPORT; } return local(flag);',
    'function local(Infinity) { return Infinity || IMPORT; } return local(flag);',
  ])('retains reachable and unknown dynamic JSON import refusals: %s', (body) => {
    const dir = buildDir();
    const source = `export default function () { ${body.replace('IMPORT', "import('./data.json', { with: { type: 'json' } })")} }`;
    const app = spec([
      module(dir, 'index.mjs', 'esm', source),
      module(dir, 'data.json', 'json', '{"value":1}'),
    ]);

    expect(() => {
      deploymentFunctions(dir, { deploymentId: DEPLOYMENT_ID, functions: { app } }, BINDINGS);
    }).toThrow('index.mjs imports ./data.json by the JSON type');
  });

  it.each([
    "export default () => import(flag ? './data.json' : './other.js', { with: { type: 'json' } });",
    "export default () => import(false ? './data.json' : './other.js', { with: { type: 'json' } });",
    "import unused from './data.json' with { type: 'json' }; export default {};",
    "export { default as unused } from './data.json' with { type: 'json' }; export default {};",
  ])('keeps static links and conditional import argument leaves in the refusal: %s', (source) => {
    const dir = buildDir();
    const app = spec([
      module(dir, 'index.mjs', 'esm', source),
      module(dir, 'data.json', 'json', '{"value":1}'),
    ]);

    expect(() => {
      deploymentFunctions(dir, { deploymentId: DEPLOYMENT_ID, functions: { app } }, BINDINGS);
    }).toThrow('index.mjs imports ./data.json by the JSON type');
  });

  it('runs a JSON module as CommonJS that exports what it parses to, and refuses one that is not JSON', () => {
    const dir = buildDir();
    const app = spec([module(dir, 'index.mjs', 'esm', 'export default { fetch() {} };')]);
    const json = '{"name":"data","list":[1,2]}';
    const withJson = (text: string, name: string): DeploymentFunctions => {
      return deploymentFunctions(
        dir,
        {
          deploymentId: DEPLOYMENT_ID,
          functions: { app: spec([...app.modules, module(dir, name, 'json', text)]) },
        },
        BINDINGS,
      );
    };

    const [worker] = withJson(json, 'data.json').workers;

    expect(worker?.modules.find((each) => each.name === 'data.json')).toStrictEqual({
      type: 'CommonJS',
      name: 'data.json',
      contents: `module.exports = JSON.parse(${JSON.stringify(json)});\n`,
    });
    expect(() => withJson('{not json', 'broken.json')).toThrow(
      'broken.json is a JSON module that is not JSON',
    );

    // Asked for by its type, a JSON module is one the CommonJS it becomes here does not answer.
    const attributed = spec([
      module(dir, 'index.mjs', 'esm', "import data from './data.json' with { type: 'json' };"),
      module(dir, 'data.json', 'json', json),
    ]);

    expect(() => {
      return deploymentFunctions(
        dir,
        { deploymentId: DEPLOYMENT_ID, functions: { app: attributed } },
        BINDINGS,
      );
    }).toThrow('index.mjs imports ./data.json by the JSON type');

    // A dynamic import by type is CommonJS's to make as well.
    const required = spec([
      module(
        dir,
        'index.cjs',
        'commonjs',
        "module.exports = { fetch: () => import('./data.json', { with: { type: 'json' } }) };",
      ),
      module(dir, 'data.json', 'json', json),
    ]);

    expect(() => {
      return deploymentFunctions(
        dir,
        {
          deploymentId: DEPLOYMENT_ID,
          functions: { app: { ...required, mainModule: 'index.cjs' } },
        },
        BINDINGS,
      );
    }).toThrow('index.cjs imports ./data.json by the JSON type');

    // Text that reads like such an import of one, in a comment or a string, is no import.
    const mentioned = spec([
      module(
        dir,
        'index.mjs',
        'esm',
        "// import data from './data.json' with { type: 'json' };\nexport default { fetch() { return new Response(\"from './data.json' with { type: 'json' }\"); } };",
      ),
      module(dir, 'data.json', 'json', json),
    ]);

    expect(
      deploymentFunctions(
        dir,
        { deploymentId: DEPLOYMENT_ID, functions: { app: mentioned } },
        BINDINGS,
      ).workers,
    ).toHaveLength(1);
  });
});
