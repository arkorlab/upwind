/**
 * Where the deployments go, and what may make them.
 *
 * Three variables, and the names are the host's own rather than this repository's: the same operator
 * script that drives this suite against the host's private harness drives it here, and a second set
 * of names for the same three values would be a second thing to keep in step. They arrive through the
 * environment alone — a token on a command line is in every process list on the machine, and a token
 * in a file is one somebody forgets.
 */

const NAMES = {
  baseUrl: 'ARKOR_API_URL',
  token: 'ARKOR_API_TOKEN',
  projectId: 'ADAPTER_TEST_PROJECT_ID',
} as const;

export interface Config {
  /** The public API's origin, for example `https://api.arkor.dev`. */
  readonly baseUrl: string;
  /** A token with the `write` scope. Never logged, never written down, never passed as an argument. */
  readonly token: string;
  /**
   * The one project every fixture is deployed into.
   *
   * Dedicated on purpose: each deployment **replaces** the project's whole runtime environment with
   * the fixture's own, so a project that anything else uses would have that taken out from under it.
   */
  readonly projectId: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (value === undefined || value === '') {
      throw new Error(`${name} is required`);
    }
    return value;
  };
  const config: Config = {
    baseUrl: required(NAMES.baseUrl),
    token: required(NAMES.token),
    projectId: required(NAMES.projectId),
  };
  const url = new URL(config.baseUrl);
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
  return config;
}

/**
 * The names this tool's own configuration goes by, so that none of it is ever handed to a fixture.
 *
 * A fixture's environment becomes the deployed Function's environment. The token that deployed it has
 * no business there, and once was sent there: a host's harness had neither prefix in its exclusion
 * list until a migration put the deploying credential into every fixture's build.
 */
export const TOOL_ENV_PREFIXES = ['ARKOR_', 'ADAPTER_TEST_'] as const;
