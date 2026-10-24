import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fakeHost } from './fake-host.ts';

/** The shell's `NODE_OPTIONS` without the one a native-TS suite's build is given (`e2e-deploy.sh`). */
export function ordinaryNodeOptions(options = ''): string | undefined {
  const kept = options
    .split(/\s+/u)
    .filter((option) => option !== '' && option !== '--experimental-transform-types');
  return kept.length === 0 ? undefined : kept.join(' ');
}

/** Check the upstream native-TS loader selection without building Next.js. */
export async function nativeConfigScenario(input: {
  readonly deploymentId: string;
  readonly appDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly deploy: (dir: string, env: NodeJS.ProcessEnv) => Promise<unknown>;
  readonly holds: (message: string, condition: boolean) => void;
}): Promise<void> {
  const host = await fakeHost(input.deploymentId);
  try {
    await input.deploy(input.appDir, {
      ...input.env,
      ARKOR_API_URL: `http://127.0.0.1:${String(host.port)}`,
      JEST_SUITE_NAME:
        'deploy:e2e:test/e2e/app-dir/next-config-ts-native-ts/export-default/next-config-ts-export-default-esm.test.ts',
    });
    const build = readFileSync(path.join(input.appDir, '.adapter-build.log'), 'utf8');
    input.holds(
      "a suite of a next.config Node.js loads itself is built with Node.js's loader",
      build.includes('__NEXT_NODE_NATIVE_TS_LOADER_ENABLED: YES'),
    );
    input.holds(
      'and with types transformed',
      build.includes('the build saw types transformed: YES'),
    );
  } finally {
    host.close();
  }
}
