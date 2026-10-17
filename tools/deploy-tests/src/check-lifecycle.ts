import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { writeApplication } from './check-application.ts';
import { fakeHost } from './fake-host.ts';

const LIFECYCLE_FILE = 'lifecycle.txt';
const STAGES = ['prebuild', 'build', 'post-build', 'postbuild'];

export function checkLifecycle(
  appDir: string,
  build: string,
  holds: (message: string, condition: boolean) => void,
): void {
  holds(
    'prebuild, build, the harness post-build, and postbuild each run once in order',
    readFileSync(path.join(appDir, LIFECYCLE_FILE), 'utf8') ===
      'prebuild\nbuild\npost-build\npostbuild\n',
  );
  holds(
    'every lifecycle script runs without tool credentials',
    STAGES.every((stage) => {
      return (
        build.includes(`${stage} saw ARKOR_API_TOKEN: no`) &&
        build.includes(`${stage} saw ARKOR_API_TOKEN_FILE: no`)
      );
    }),
  );
}

/** Focused failures and the no-build fallback, without building Next.js or reaching a platform. */
export async function lifecycleScenarios(input: {
  readonly deploymentId: string;
  readonly workDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly deploy: (dir: string, env: NodeJS.ProcessEnv) => Promise<unknown>;
  readonly holds: (message: string, condition: boolean) => void;
}): Promise<void> {
  for (const [index, stage] of ['prebuild', 'build', 'postbuild'].entries()) {
    const dir = path.join(input.workDir, `lifecycle-${stage}`);
    writeApplication(dir);
    const host = await fakeHost(input.deploymentId);
    try {
      let failure: unknown;
      try {
        await input.deploy(dir, {
          ...input.env,
          ARKOR_API_URL: `http://127.0.0.1:${String(host.port)}`,
          CHECK_FAIL_LIFECYCLE: stage,
        });
      } catch (error) {
        failure = error;
      }
      const stages = readFileSync(path.join(dir, LIFECYCLE_FILE), 'utf8');
      const expected = STAGES.slice(0, stage === 'postbuild' ? STAGES.length : index + 1);
      input.holds(`${stage} failure stops the lifecycle`, stages === `${expected.join('\n')}\n`);
      input.holds(`${stage} failure fails the hook`, failure instanceof Error);
      input.holds(`${stage} failure never registers a deployment`, host.registered() === undefined);
      input.holds(
        `${stage} failure never publishes valid build markers`,
        !existsSync(path.join(dir, '.adapter-build.log')),
      );
    } finally {
      host.close();
    }
  }

  const dir = path.join(input.workDir, 'no-build-script');
  writeApplication(dir);
  writeFileSync(path.join(dir, 'package.json'), '{"name":"no-build-script","private":true}\n');
  mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(
    path.join(dir, 'node_modules', '.bin', 'next'),
    '#!/bin/sh\n[ "$1" = build ] || exit 1\nexec node build.mjs\n',
    { mode: 0o755 },
  );
  const host = await fakeHost(input.deploymentId);
  try {
    await input.deploy(dir, {
      ...input.env,
      ARKOR_API_URL: `http://127.0.0.1:${String(host.port)}`,
      ADAPTER_TEST_SETTLE_SECONDS: '0',
    });
    input.holds('an absent build script falls back to next build', host.registered() !== undefined);
    input.holds(
      'the fallback invents no lifecycle scripts',
      !existsSync(path.join(dir, LIFECYCLE_FILE)),
    );
  } finally {
    host.close();
  }
}
