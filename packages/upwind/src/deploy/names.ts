import {
  appFunctions,
  DEPLOYMENT_ID_PREFIX,
  type DeploymentBundle,
  PRIMARY_FUNCTION,
} from '@stayingupwind/core/bundle';
import type { AppRuntime } from '@stayingupwind/core/manifest';
import { formatId, fromDnsLabel, parseId, toDnsLabel } from '@stayingupwind/core/util';

/**
 * What everything `upwind deploy` makes on an account is called.
 *
 * Every name is a function of the project's name and, for what belongs to one deployment, of that
 * deployment's id — nothing is remembered anywhere else. A later run finds what an earlier one made
 * by asking for it by name, and a deployment's Workers are known from the deployment alone, even
 * after nothing else names them.
 *
 * A Worker's name is a DNS label: `workers.dev` serves a Worker as `<name>.<subdomain>.workers.dev`,
 * so the name may hold only lowercase letters, digits and hyphens, and no more than 63 of them. A
 * deployment id is Base58 (`dpl_` and 21 characters, upper and lower case), which no hostname can
 * carry; the same id is written as a lowercase base32 label of 25 characters instead, which turns
 * back into the id it came from (`deploymentOfLabel`).
 */

/** What a project's name may be: 2 to 24 characters, lowercase, no doubled or trailing hyphen. */
export const PROJECT_NAME = /^[a-z](?:[a-z\d]|-(?!-)){0,22}[a-z\d]$/u;
const PROJECT_NAME_MAX = 24;

/** The middleware's role in its Worker's name; an app Function's role is its own name. */
const MIDDLEWARE_ROLE = 'mw';

/**
 * A project's name from its package's, made to fit: the scope dropped, lowercased, every run of
 * characters a hostname cannot carry turned into one hyphen, and cut to length. Nothing when what is
 * left is still not a name — the project then has to say which name it wants (`deploy.name`).
 */
export function projectNameFromPackage(packageName: string | undefined): string | undefined {
  if (packageName === undefined) {
    return undefined;
  }
  const slash = packageName.startsWith('@') ? packageName.indexOf('/') : -1;
  const hyphenated = packageName
    .slice(slash + 1)
    .toLowerCase()
    .replaceAll(/[^a-z\d]+/gu, '-');
  const first = hyphenated.search(/[a-z]/u);
  let fitted = first === -1 ? '' : hyphenated.slice(first, first + PROJECT_NAME_MAX);
  while (fitted.endsWith('-')) {
    fitted = fitted.slice(0, -1);
  }
  return PROJECT_NAME.test(fitted) ? fitted : undefined;
}

/** A deployment's label: its id as a lowercase base32 DNS label. */
export function deploymentLabel(deploymentId: string): string {
  const payload = parseId(DEPLOYMENT_ID_PREFIX, deploymentId);
  if (payload === undefined) {
    throw new Error(`${deploymentId} is not a deployment id`);
  }
  return toDnsLabel(payload);
}

/** The deployment a label names, or nothing for a label that names none. */
export function deploymentOfLabel(label: string): string | undefined {
  const payload = fromDnsLabel(label);
  return payload === undefined ? undefined : formatId(DEPLOYMENT_ID_PREFIX, payload);
}

/** The Workers and stores a project keeps across its deployments. */
export interface ProjectNames {
  readonly project: string;
  /** The edge, deployed again — a new version — for each deployment. */
  readonly edge: string;
  readonly cache: string;
  readonly cacheRead: string;
  readonly prefetch: string;
  /** What a deploy writes the deployment's stores through; nothing else can reach them. */
  readonly agent: string;
  /** KV namespaces are found by title, and a title may say whose it is. */
  readonly edgeStateTitle: string;
  readonly cacheStateTitle: string;
  /** An R2 bucket's name is a DNS label of its own, like a Worker's. */
  readonly artifactsBucket: string;
}

export function projectNames(project: string): ProjectNames {
  if (!PROJECT_NAME.test(project)) {
    throw new Error(
      `${project} is not a project name: 2 to 24 lowercase letters, digits and single hyphens, from a letter`,
    );
  }
  return {
    project,
    edge: `${project}-edge`,
    cache: `${project}-cache`,
    cacheRead: `${project}-cache-read`,
    prefetch: `${project}-prefetch`,
    agent: `${project}-agent`,
    edgeStateTitle: `upwind:${project}:edge-state`,
    cacheStateTitle: `upwind:${project}:cache-state`,
    artifactsBucket: `${project}-artifacts`,
  };
}

/**
 * A Function's Worker: the project, the deployment's label, and the Function's role — `app`,
 * `app-2` and on for a split build, `mw` for the middleware. At most 24 + 1 + 25 + 1 + 7 = 58
 * characters for the most Functions a build can have.
 */
export function functionScriptName(project: string, deploymentId: string, role: string): string {
  return `${project}-${deploymentLabel(deploymentId)}-${role}`;
}

/** What follows the project's name in a Function's Worker: the deployment's label and the role. */
const FUNCTION_SUFFIX = /^([a-z2-7]{25})-(?:app(?:-\d+)?|mw)$/u;

/**
 * The deployment a Worker belongs to, where it is a Function of the project's — known by its name
 * alone; nothing for any other Worker.
 */
export function deploymentOfScript(project: string, scriptName: string): string | undefined {
  const prefix = `${project}-`;
  if (!scriptName.startsWith(prefix)) {
    return undefined;
  }
  const label = FUNCTION_SUFFIX.exec(scriptName.slice(prefix.length))?.[1];
  return label === undefined ? undefined : deploymentOfLabel(label);
}

/** One of a deployment's Functions, by the name the build gave it and the Worker it becomes. */
export interface FunctionScript {
  /** `app`, `app-2`…, or `middleware`. */
  readonly name: string;
  readonly scriptName: string;
}

/** Every Function of a build and its Worker, the first app Function first and the middleware last. */
export function functionScripts(
  project: string,
  bundle: Pick<DeploymentBundle, 'deploymentId' | 'functions'>,
): readonly FunctionScript[] {
  const scriptOf = (name: string): FunctionScript => {
    const scriptName = functionScriptName(project, bundle.deploymentId, name);
    return { name, scriptName };
  };
  const scripts = appFunctions(bundle).map(([name]) => scriptOf(name));
  if (bundle.functions.middleware !== undefined) {
    scripts.push({
      name: 'middleware',
      scriptName: functionScriptName(project, bundle.deploymentId, MIDDLEWARE_ROLE),
    });
  }
  return scripts;
}

/** The deployment's Functions as the edge's pointer names them. */
export function appRuntimeOf(
  project: string,
  bundle: Pick<DeploymentBundle, 'deploymentId' | 'functions'>,
): AppRuntime {
  const scripts = functionScripts(project, bundle);
  const split = scripts.filter((script) => script.name.startsWith(`${PRIMARY_FUNCTION}-`));
  const middleware = scripts.find((script) => script.name === 'middleware');
  return {
    deploymentId: bundle.deploymentId,
    scriptName: functionScriptName(project, bundle.deploymentId, PRIMARY_FUNCTION),
    ...(middleware !== undefined && { middlewareScriptName: middleware.scriptName }),
    ...(split.length > 0 && {
      functions: Object.fromEntries(split.map((script) => [script.name, script.scriptName])),
    }),
  };
}
