import type { PackageInstall } from './build-context.ts';

/** BuildKit mounts the declared variables only while the dependency/build process runs. */
export function buildScript(input: {
  readonly install: PackageInstall;
  readonly project: string;
  readonly deploymentId: string;
  readonly prepare?: readonly string[];
}): string {
  return `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const env = { ...process.env, ...JSON.parse(readFileSync('/run/secrets/upwind-build-env', 'utf8')) };
if (existsSync('/run/secrets/upwind-npmrc')) {
  env.NPM_CONFIG_USERCONFIG = '/run/secrets/upwind-npmrc';
  env.npm_config_userconfig = '/run/secrets/upwind-npmrc';
}
const run = (argv, cwd) => {
  const result = spawnSync(argv[0], argv.slice(1), { cwd, env, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('container build command failed: ' + argv[0]);
};
${input.install.manager === 'bun' ? `run(['npm', 'install', '--global', ${JSON.stringify(input.install.specification.split('+')[0])}], '/workspace');` : ''}
run(${JSON.stringify(input.install.command)}, '/workspace');
${input.prepare === undefined ? '' : `run(${JSON.stringify(input.prepare)}, '/workspace');`}
const project = ${JSON.stringify(`/workspace/${input.project}`)};
const require = createRequire(path.join(project, 'package.json'));
const manifestPath = require.resolve('upwind/package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.upwind;
if (typeof bin !== 'string') throw new Error('upwind is not installed in the application');
Object.assign(env, {
  UPWIND_AWS_BUILD: '1',
  UPWIND_BUILD_TARGET: 'node',
  NEXT_DEPLOYMENT_ID: ${JSON.stringify(input.deploymentId)},
});
run([process.execPath, path.resolve(path.dirname(manifestPath), bin), 'build', '--target=node'], project);
const result = JSON.parse(readFileSync(path.join(project, '.arkor/node/manifest.json'), 'utf8'));
if (result.aws !== 1 || result.deploymentId !== ${JSON.stringify(input.deploymentId)}) throw new Error('the project adapter did not emit this AWS native deployment');
writeFileSync(path.join(project, '.arkor/node/build-runtime.json'), JSON.stringify({
  nodeVersion: process.versions.node,
  nodeAbi: process.versions.modules,
  platform: process.platform,
  architecture: process.arch,
}));
`;
}

/** Both stages use the identical resolved base digest and target platform. */
export function dockerfile(input: {
  readonly baseImageDigest: string;
  readonly project: string;
  readonly deploymentId: string;
}): string {
  if (!/^node@sha256:[a-f0-9]{64}$/u.test(input.baseImageDigest))
    throw new Error('resolve the immutable Node image digest first');
  return `# syntax=docker/dockerfile:1
FROM ${input.baseImageDigest} AS build
RUN apt-get update && apt-get install --yes --no-install-recommends python3 make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global corepack@0.36.0
WORKDIR /workspace
COPY source/ /workspace/
COPY build.mjs /upwind/build.mjs
RUN --mount=type=secret,id=upwind-build-env,required=true --mount=type=secret,id=upwind-npmrc node /upwind/build.mjs

FROM ${input.baseImageDigest} AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV UPWIND_NODE_CACHE_DIR=/tmp/upwind
WORKDIR /app
COPY --from=build --chown=node:node ${JSON.stringify(`/workspace/${input.project === '' ? '' : `${input.project}/`}.arkor/node/`)} /app/
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
LABEL io.stayingupwind.deployment=${JSON.stringify(input.deploymentId)}
LABEL io.stayingupwind.base=${JSON.stringify(input.baseImageDigest)}
CMD ["node", "server.mjs"]
`;
}
