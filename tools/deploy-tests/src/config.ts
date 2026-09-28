import { readFileSync } from 'node:fs';

/**
 * Where the deployments go, and what may make them.
 *
 * Three variables, and the names are the host's own rather than this repository's: the same operator
 * script that drives this suite against the host's private harness drives it here, and a second set
 * of names for the same three values would be a second thing to keep in step. They arrive through the
 * environment alone — a token on a command line is in every process list on the machine, and a token
 * in a file is one somebody forgets.
 */

/** Where a token may travel without TLS, because it does not leave the machine. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

const NAMES = {
  baseUrl: 'ARKOR_API_URL',
  token: 'ARKOR_API_TOKEN',
  tokenFile: 'ARKOR_API_TOKEN_FILE',
  projectId: 'ADAPTER_TEST_PROJECT_ID',
} as const;

/** Which project on which host, which is all that naming a claim takes. */
export interface ProjectConfig {
  /** The public API's origin, for example `https://api.arkor.dev`. */
  readonly baseUrl: string;
  /**
   * The one project every fixture is deployed into.
   *
   * Dedicated on purpose: each deployment **replaces** the project's whole runtime environment with
   * the fixture's own, so a project that anything else uses would have that taken out from under it.
   */
  readonly projectId: string;
}

export interface Config extends ProjectConfig {
  /** A token with the `write` scope. Never logged, never written down, never passed as an argument. */
  readonly token: string;
}

/**
 * The token, from the environment or from a file the environment names.
 *
 * The file is there for a run that hands the suite its environment: everything below the deploy hook
 * — the application's install, its build, the suite itself — inherits that environment, and all of it
 * is somebody else's code. A path is the one thing worth inheriting. It is a reduction rather than a
 * boundary, since a process can read what another process of its own user can; what it removes is the
 * ordinary way a secret escapes, which is something printing the environment it was handed.
 */
function tokenIn(env: NodeJS.ProcessEnv): string {
  const direct = env[NAMES.token]?.trim();
  if (direct !== undefined && direct !== '') {
    return direct;
  }
  const file = env[NAMES.tokenFile]?.trim();
  if (file === undefined || file === '') {
    throw new Error(`${NAMES.token} or ${NAMES.tokenFile} is required`);
  }
  const read = readFileSync(file, 'utf8').trim();
  if (read === '') {
    throw new Error(`${file} holds no token`);
  }
  return read;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

/**
 * Which project, on which host — everything but the credential.
 *
 * Giving the project back asks nothing of the API (the claim is a file on this machine), so the
 * cleanup hook does not have to be handed a token to do it. A hook that demanded one would fail on a
 * run whose credential had already been taken away, and leave a claim behind for no reason.
 */
export function readProjectConfig(env: NodeJS.ProcessEnv = process.env): ProjectConfig {
  const config: ProjectConfig = {
    baseUrl: required(env, NAMES.baseUrl),
    projectId: required(env, NAMES.projectId),
  };
  checkBaseUrl(config.baseUrl);
  return config;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config: Config = { ...readProjectConfig(env), token: tokenIn(env) };
  return config;
}

function checkBaseUrl(baseUrl: string): void {
  const url = new URL(baseUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(
      `${NAMES.baseUrl} must be an HTTP(S) URL without credentials, query or fragment`,
    );
  }
  // Plain HTTP only to this machine. The token goes out in an `Authorization` header on every call, and
  // a mistyped scheme against a real host would put it on the network in the clear; loopback is where a
  // fake host answers, which is what `check:deploy-tests` and a local experiment use.
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    throw new Error(`${NAMES.baseUrl} must be HTTPS unless it names this machine`);
  }
  // A path of its own would be dropped rather than honoured: every call names an absolute path
  // (`/v1/…`), which resolves against the origin. Refused here, where it can still be said, instead
  // of arriving as a run of refusals from somewhere that was never asked the question.
  if (url.pathname !== '/') {
    throw new Error(`${NAMES.baseUrl} must name an origin, without a path of its own`);
  }
}

/**
 * The names this tool's own configuration goes by, so that none of it is ever handed to a fixture.
 *
 * A fixture's environment becomes the deployed Function's environment. The token that deployed it has
 * no business there, and once was sent there: a host's harness had neither prefix in its exclusion
 * list until a migration put the deploying credential into every fixture's build.
 */
export const TOOL_ENV_PREFIXES = ['ARKOR_', 'ADAPTER_TEST_'] as const;
