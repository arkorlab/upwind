import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { BUNDLE_BUILD_ID, writeApplication } from './check-application.ts';
import { fakeHost } from './fake-host.ts';

/**
 * A workspace whose build script builds one of its packages, as `pnpm run --dir apps/web build` does
 * (`import-meta-glob-monorepo`): the adapter writes the bundle beside that package, and the deployment
 * is made from it — its build id in the markers, its blobs uploaded, the package's own `.env` as the
 * deployment's environment. A workspace whose build left a bundle in two places — two packages, or
 * the workspace itself and a package — is refused, naming both, rather than deployed from a guess.
 */

const PACKAGES = 'apps';
const BUILT = 'web';
const ALSO_BUILT = 'admin';
const BUILD_ID_MARKER = 'BUILD_ID: ';

/** What `check.ts` hands the scenario: the deploy hook, and how its own assertions are made. */
interface WorkspaceCheck {
  readonly deploymentId: string;
  readonly workDir: string;
  readonly env: NodeJS.ProcessEnv;
  /** The deploy hook, run in `dir`. */
  readonly deploy: (dir: string, env: NodeJS.ProcessEnv) => Promise<{ readonly stdout: string }>;
  /** What a hook that failed said on standard error; `undefined` for anything else. */
  readonly said: (error: unknown) => string | undefined;
  readonly holds: (said: string, held: boolean) => void;
}

export async function workspaceScenario(check: WorkspaceCheck): Promise<void> {
  const { deploy, holds } = check;
  const root = path.join(check.workDir, 'workspace');
  const web = path.join(root, PACKAGES, BUILT);
  mkdirSync(web, { recursive: true });
  writeApplication(web);
  const manifest = {
    name: 'deploy-tests-check-workspace',
    private: true,
    scripts: { build: `cd ${PACKAGES}/${BUILT} && node build.mjs` },
  };
  writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const host = await fakeHost(check.deploymentId);
  try {
    const url = `http://127.0.0.1:${String(host.port)}`;
    const deployed = await deploy(root, { ...check.env, ARKOR_API_URL: url });
    const [first] = readFileSync(path.join(root, '.adapter-build.log'), 'utf8').split('\n', 1);
    holds(
      'a workspace that builds one package is deployed from the bundle beside that package',
      deployed.stdout.trim() === url &&
        host.registered() === BUNDLE_BUILD_ID &&
        host.uploaded().length === 1,
    );
    holds(
      'with the build id that bundle names in the markers',
      first === `${BUILD_ID_MARKER}${BUNDLE_BUILD_ID}`,
    );
    holds(
      "and the package's own .env as the deployment's environment",
      JSON.stringify(host.environment()) === JSON.stringify({ OWN: 'yes' }),
    );
  } finally {
    host.close();
  }
  cpSync(path.join(web, '.arkor'), path.join(root, PACKAGES, ALSO_BUILT, '.arkor'), {
    recursive: true,
  });
  let refused: unknown;
  try {
    await deploy(root, check.env);
  } catch (error) {
    refused = error;
  }
  const said = check.said(refused) ?? '';
  holds(
    'a workspace whose build left a bundle in two packages is refused, naming both',
    said.includes(path.join(PACKAGES, ALSO_BUILT)) && said.includes(path.join(PACKAGES, BUILT)),
  );
  // And one left beside the workspace itself as well as in a package: the root is a candidate too.
  rmSync(path.join(root, PACKAGES, ALSO_BUILT), { recursive: true, force: true });
  cpSync(path.join(web, '.arkor'), path.join(root, '.arkor'), { recursive: true });
  let alsoRoot: unknown;
  try {
    await deploy(root, check.env);
  } catch (error) {
    alsoRoot = error;
  }
  const saidOfRoot = check.said(alsoRoot) ?? '';
  holds(
    'and so is one whose build left a bundle beside the workspace and in a package',
    saidOfRoot.includes('(., ') && saidOfRoot.includes(path.join(PACKAGES, BUILT)),
  );
}
