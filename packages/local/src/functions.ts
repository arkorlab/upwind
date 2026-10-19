import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  appFunctions,
  type DeploymentBundle,
  type FunctionModuleType,
  type FunctionSpec,
  PRIMARY_FUNCTION,
} from '@stayingupwind/core/bundle';
import type { AppRuntime } from '@stayingupwind/core/manifest';
import type { ServiceBinding, TextBinding } from '@stayingupwind/deploy/bindings';
import { buildSync } from 'esbuild';

import type { LocalModule, LocalWorker, ModuleType } from './miniflare.ts';

/**
 * Each kind of module a Function holds, as Miniflare runs it. A `json` module has no form there — a
 * deployed one is imported as the value it parses to — and is refused (`moduleOf`) rather than run
 * as something else.
 */
const MODULE_TYPES: Readonly<Record<Exclude<FunctionModuleType, 'json'>, ModuleType>> = {
  esm: 'ESModule',
  commonjs: 'CommonJS',
  text: 'Text',
  data: 'Data',
  wasm: 'CompiledWasm',
};

/** Each Function runs as its name in the bundle under this prefix: `upwind-app`, `upwind-app-2`. */
const SCRIPT_PREFIX = 'upwind-';
const MIDDLEWARE = 'middleware';

/** What every Function of the deployment is bound to, as whatever deploys it binds each. */
export interface FunctionBindings {
  readonly text: readonly TextBinding[];
  /** Each by the Worker of the stack it reaches. */
  readonly services: readonly ServiceBinding[];
  /** The application's own stores, each binding by the id of the store the stack keeps for it. */
  readonly stores?: FunctionStores | undefined;
}

export interface FunctionStores {
  readonly kvNamespaces?: Readonly<Record<string, string>> | undefined;
  readonly r2Buckets?: Readonly<Record<string, string>> | undefined;
  readonly d1Databases?: Readonly<Record<string, string>> | undefined;
}

export interface DeploymentFunctions {
  /** The Functions as the deployment's manifest and pointer name them. */
  readonly app: AppRuntime;
  readonly workers: readonly LocalWorker[];
}

/**
 * A JSON module, as Miniflare can run one: it has no type for JSON, so the module is CommonJS that
 * exports the value the JSON parses to — what a deployed JSON module is to an `import` (its default)
 * and to a `require` alike. Parsed when it loads, as the runtime parses one; refused here where the
 * bytes are not JSON, which a deploy would refuse too. A build that imports one with an import
 * attribute, which only a module of JSON's own type answers, is refused where its Functions are
 * made (`refusedJsonImport`).
 */
function jsonModule(name: string, text: string): LocalModule {
  try {
    JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} is a JSON module that is not JSON`, { cause: error });
  }
  return {
    type: 'CommonJS',
    name,
    contents: `module.exports = JSON.parse(${JSON.stringify(text)});\n`,
  };
}

/**
 * A module as the build named it, or a refusal: bytes that are not the blob its bundle names are
 * not what a deploy would upload, and a stack that ran them would prove nothing of the build.
 */
function moduleOf(blobs: string, module: FunctionSpec['modules'][number]): LocalModule {
  const bytes = readFileSync(path.join(blobs, module.blob.sha256));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== module.blob.byteLength || sha256 !== module.blob.sha256) {
    throw new Error(`${module.name} is not the blob its bundle names (${module.blob.sha256})`);
  }
  if (module.type === 'json') {
    return jsonModule(module.name, bytes.toString('utf8'));
  }
  const type = MODULE_TYPES[module.type];
  return {
    type,
    name: module.name,
    contents:
      type === 'Data' || type === 'CompiledWasm' ? new Uint8Array(bytes) : bytes.toString('utf8'),
  };
}

/**
 * The specifiers a module imports by the JSON type (an import attribute: `with`, or the older
 * `assert`), static or dynamic, as esbuild parses the module: its imports, and nothing that only
 * reads like one in a string or a comment. None where esbuild cannot read the module, which is no
 * reason to refuse what the runtime may run.
 */
function jsonImportsOf(name: string, source: string): string[] {
  try {
    const { metafile } = buildSync({
      stdin: { contents: source, loader: 'js', sourcefile: name },
      bundle: true,
      external: ['*'],
      format: 'esm',
      platform: 'neutral',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    return Object.values(metafile.inputs).flatMap((input) => {
      return input.imports
        .filter((imported) => imported.with?.['type'] === 'json')
        .map((imported) => imported.path);
    });
  } catch {
    return [];
  }
}

/**
 * Why a Function cannot run here: one of its modules imports one of its JSON modules (`json`) by
 * the JSON type, which the CommonJS a JSON module becomes here does not answer — resolved as the
 * runtime resolves a relative specifier.
 */
function refusedJsonImport(
  modules: readonly LocalModule[],
  json: ReadonlySet<string>,
): string | undefined {
  for (const module of modules) {
    // Either kind of JavaScript may import by type — a dynamic import is CommonJS's as well — but
    // not the CommonJS a JSON module becomes here, which imports nothing.
    const javascript =
      (module.type === 'ESModule' || module.type === 'CommonJS') && !json.has(module.name);
    const source = javascript ? module.contents : undefined;
    const imported = typeof source === 'string' ? jsonImportsOf(module.name, source) : [];
    const named = imported.find((specifier) =>
      json.has(path.posix.join(path.posix.dirname(module.name), specifier)),
    );
    if (named !== undefined) {
      return `${module.name} imports ${named} by the JSON type, which a local stack cannot answer: Miniflare has no JSON module type`;
    }
  }
  return undefined;
}

/** A Function as the build left it, its main module first, bound as every Function is. */
function functionWorker(
  blobs: string,
  name: string,
  spec: FunctionSpec,
  bindings: FunctionBindings,
): LocalWorker {
  const main = spec.modules.filter((module) => module.name === spec.mainModule);
  // One module of the name, or a module the deploy would not run would run here in its place.
  if (main.length !== 1) {
    throw new Error(
      `${name}'s main module ${spec.mainModule} is ${main.length === 0 ? 'none' : 'more than one'} of its modules`,
    );
  }
  const rest = spec.modules.filter((module) => module.name !== spec.mainModule);
  const modules = [...main, ...rest].map((module) => moduleOf(blobs, module));
  const json = new Set(
    spec.modules.filter((module) => module.type === 'json').map((module) => module.name),
  );
  const refused = json.size > 0 ? refusedJsonImport(modules, json) : undefined;
  if (refused !== undefined) {
    throw new Error(refused);
  }
  return {
    name,
    modules,
    compatibilityDate: spec.compatibilityDate,
    compatibilityFlags: spec.compatibilityFlags,
    // Later names win, so the deployment's own bindings take a name the application also used.
    bindings: Object.fromEntries(bindings.text.map((binding) => [binding.name, binding.value])),
    services: Object.fromEntries(
      bindings.services.map((binding) => {
        const target =
          binding.entrypoint === undefined && binding.props === undefined
            ? binding.service
            : {
                name: binding.service,
                ...(binding.entrypoint !== undefined && { entrypoint: binding.entrypoint }),
                ...(binding.props !== undefined && { props: binding.props }),
              };
        return [binding.name, target];
      }),
    ),
    ...bindings.stores,
  };
}

/**
 * The deployment's Functions as Workers of the stack, from the build's own blobs: every app
 * Function, the first (`app`) first, and the middleware's where the build has one — each given the
 * same bindings, as a deployed one is. A build with a workflow Function is refused: a stack runs no
 * workflow World for it, and would serve it as though its workflows ran. So is one with Durable
 * Objects of its own, which a stack runs none of: its Functions would be served without the
 * namespaces a deploy binds them to.
 */
export function deploymentFunctions(
  bundleDir: string,
  bundle: Pick<DeploymentBundle, 'deploymentId' | 'durableObjects' | 'functions'>,
  bindings: FunctionBindings,
): DeploymentFunctions {
  if (bundle.functions.workflow !== undefined) {
    throw new Error(
      `${bundle.deploymentId} runs workflows, and a local stack runs no workflow World for it`,
    );
  }
  const objects = new Set((bundle.durableObjects ?? []).map((object) => object.name));
  const built = bundle.functions.durableObjects;
  if (built !== undefined) {
    for (const name of Object.keys(built)) {
      objects.add(name);
    }
  }
  if (objects.size > 0) {
    throw new Error(
      `${bundle.deploymentId} has Durable Objects of its own (${[...objects].join(', ')}), and a local stack runs none for it`,
    );
  }
  const blobs = path.join(bundleDir, 'blobs');
  const apps = appFunctions(bundle).map(([name, spec]) => {
    const scriptName = `${SCRIPT_PREFIX}${name}`;
    return { name, scriptName, spec };
  });
  const workers = apps.map((app) => functionWorker(blobs, app.scriptName, app.spec, bindings));
  const split = apps.filter((app) => app.name !== PRIMARY_FUNCTION);
  const { middleware } = bundle.functions;
  const middlewareScriptName = `${SCRIPT_PREFIX}${MIDDLEWARE}`;
  if (middleware !== undefined) {
    workers.push(functionWorker(blobs, middlewareScriptName, middleware, bindings));
  }
  return {
    app: {
      deploymentId: bundle.deploymentId,
      scriptName: `${SCRIPT_PREFIX}${PRIMARY_FUNCTION}`,
      ...(middleware !== undefined && { middlewareScriptName }),
      ...(split.length > 0 && {
        functions: Object.fromEntries(split.map((app) => [app.name, app.scriptName])),
      }),
    },
    workers,
  };
}
