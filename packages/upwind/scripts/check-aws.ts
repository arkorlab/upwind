import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  appendFile,
  cp,
  mkdir,
  readFile,
  readdir,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { verifyFargateArchive } from '../src/aws/build-verify.ts';
import { fargateDirectory, readFargateBuild } from '../src/aws/receipt.ts';
import { awsDeploySettings } from '../src/aws/settings.ts';
import type { FargateBuildReceipt } from '../src/aws/types.ts';
import { cliOf, command, packAll, succeed } from './check-deploy-build.ts';

/**
 * The AWS build as an installed release runs it. CI supplies Docker, not AWS credentials:
 * a fresh Linux dependency install builds a Next.js application and native sharp binding,
 * and an ordinary image entrypoint checks that binding without starting the AWS server.
 *
 * The context is a monorepo on purpose. Its root lockfile, shared package's prepare command,
 * local release tarballs, build secrets and ignored host dependencies must all survive the
 * boundary between the published CLI and its target-platform container build.
 */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const REQUEST_TIMEOUT_MS = 30_000;

interface Fixture {
  readonly context: string;
  readonly source: string;
  readonly sentinels: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

function say(message: string): void {
  console.log(`check-aws: ${message}`);
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function pack(name: string): string {
  return `file:packages/${name}.tgz`;
}

async function fixture(out: string): Promise<Fixture> {
  const context = path.join(out, 'context');
  await mkdir(context);
  await packAll(context);
  const source = path.join(context, 'source');
  await cp(path.join(ROOT, 'fixtures/next-native'), source, {
    recursive: true,
    filter: (file) =>
      !['.arkor', '.next', '.upwind', 'node_modules', 'package-lock.json'].includes(
        path.basename(file),
      ),
  });
  const npm = command('npm', ['--version'], { cwd: context, capture: true }).stdout.trim();
  assert.match(npm, /^\d+\.\d+\.\d+$/u, 'npm must expose the exact package-manager version');
  await writeJson(path.join(context, 'package.json'), {
    name: 'upwind-ci-aws-build',
    private: true,
    type: 'module',
    packageManager: `npm@${npm}`,
    workspaces: ['source', 'packages/shared'],
    devDependencies: { upwind: pack('upwind'), '@stayingupwind/adapter': pack('adapter') },
    overrides: { '@stayingupwind/core': pack('core'), '@stayingupwind/runtime': pack('runtime') },
  });
  const applicationFile = path.join(source, 'package.json');
  const application = JSON.parse(await readFile(applicationFile, 'utf8')) as {
    readonly dependencies?: Readonly<Record<string, string>>;
  };
  await writeJson(applicationFile, {
    ...application,
    dependencies: { ...application.dependencies, '@upwind-ci/shared': '*' },
  });
  const shared = path.join(context, 'packages/shared');
  await mkdir(shared);
  await writeJson(path.join(shared, 'package.json'), {
    name: '@upwind-ci/shared',
    version: '1.0.0',
    private: true,
    type: 'module',
    main: './dist/index.js',
  });
  await writeFile(
    path.join(source, 'app/page.js'),
    `import { prepared } from '@upwind-ci/shared';
export default function Page() { return <p>{'aws-workspace:' + prepared}</p>; }
`,
  );
  await writeFile(
    path.join(context, 'prepare.mjs'),
    `import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
assert.match(process.env.CI_PRIVATE_BUILD_TOKEN ?? '', /^upwind-ci-build-/);
for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'CLOUDFLARE_API_TOKEN']) assert.equal(process.env[key], undefined, key + ' leaked into the build');
for (const file of ['.aws/credentials', 'source/.env.production', 'node_modules/.host-platform-marker', '.npmrc']) assert.equal(existsSync(file), false, file + ' leaked into the context');
assert.equal(process.env.NPM_CONFIG_USERCONFIG, '/run/secrets/upwind-npmrc');
assert.ok(readFileSync(process.env.NPM_CONFIG_USERCONFIG, 'utf8').includes('unused.registry.invalid'));
mkdirSync('packages/shared/dist', { recursive: true });
writeFileSync('packages/shared/dist/index.js', 'export const prepared = ' + JSON.stringify(process.platform + ':' + process.arch) + ';\\n');
`,
  );
  await writeJson(path.join(source, 'upwind.json'), {
    deploy: {
      target: 'aws',
      name: 'upwind-ci-aws-build',
      aws: {
        compute: 'fargate',
        region: 'us-east-1',
        architecture: 'x86_64',
        cache: { backend: 'dynamodb' },
        build: {
          context: '..',
          prepare: ['node', './prepare.mjs'],
          env: ['CI_PRIVATE_BUILD_TOKEN', 'NEXT_TELEMETRY_DISABLED'],
        },
      },
    },
  });
  const id = randomUUID();
  const sentinels = [
    `upwind-ci-build-${id}`,
    `upwind-ci-aws-key-${id}`,
    `upwind-ci-aws-secret-${id}`,
    `upwind-ci-cloudflare-${id}`,
    `upwind-ci-npmrc-${id}`,
    `upwind-ci-dotenv-${id}`,
  ];
  await mkdir(path.join(context, '.aws'));
  await writeFile(path.join(context, '.aws/credentials'), sentinels[2] ?? '');
  await writeFile(
    path.join(source, '.env.production'),
    `IGNORED_BUILD_SECRET=${sentinels[5] ?? ''}\n`,
  );
  // This registry is never contacted; the inline token proves that .npmrc is a secret mount.
  await writeFile(
    path.join(context, '.npmrc'),
    `audit=false\nfund=false\nlegacy-peer-deps=true\n//unused.registry.invalid/:_authToken=${sentinels[4] ?? ''}\n`,
  );
  succeed('npm', ['install', '--no-audit', '--no-fund'], context);
  await writeFile(
    path.join(context, 'node_modules/.host-platform-marker'),
    'host dependencies must not be copied',
  );
  return {
    context,
    source,
    sentinels,
    environment: {
      CI_PRIVATE_BUILD_TOKEN: sentinels[0] ?? '',
      AWS_ACCESS_KEY_ID: sentinels[1] ?? '',
      AWS_SECRET_ACCESS_KEY: sentinels[2] ?? '',
      CLOUDFLARE_API_TOKEN: sentinels[3] ?? '',
      AWS_EC2_METADATA_DISABLED: 'true',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  };
}

async function withEnvironment<T>(
  values: Readonly<Record<string, string>>,
  body: () => Promise<T>,
): Promise<T> {
  const old = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try {
    return await body();
  } finally {
    for (const [key, value] of old) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}

/** Scan incrementally, including matches split over read chunks. */
async function excludesSecrets(file: string, sentinels: readonly string[]): Promise<void> {
  const needles = sentinels.map((value) => Buffer.from(value));
  const retained = Math.max(...needles.map((value) => value.byteLength)) - 1;
  let tail = Buffer.alloc(0);
  for await (const raw of createReadStream(file)) {
    const bytes = Buffer.concat([tail, raw as Buffer]);
    for (const needle of needles)
      assert.equal(
        bytes.indexOf(needle),
        -1,
        'a build or deployment secret escaped into the native artifact/image',
      );
    tail = bytes.subarray(Math.max(0, bytes.byteLength - retained));
  }
}

async function nativeImage(receipt: FargateBuildReceipt, context: string): Promise<void> {
  const script = `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const manifest = JSON.parse(readFileSync('/app/manifest.json', 'utf8'));
const require = createRequire(path.join('/app', manifest.projectDir, 'package.json'));
const sharp = require('sharp');
const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: 'red' } }).png().toBuffer();
assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
console.log(JSON.stringify({ platform: process.platform, architecture: process.arch, nodeVersion: process.versions.node, nodeAbi: process.versions.modules, sharp: true }));
`;
  const { status, stdout } = command(
    'docker',
    ['run', '--rm', '--entrypoint', 'node', receipt.imageId, '--input-type=module', '-e', script],
    { cwd: context, capture: true },
  );
  assert.equal(status, 0, 'the built image must load its native sharp dependency');
  const result: unknown = JSON.parse(stdout.trim());
  assert.deepEqual(result, {
    platform: 'linux',
    architecture: 'x64',
    nodeVersion: receipt.nodeVersion,
    nodeAbi: receipt.nodeAbi,
    sharp: true,
  });
}

async function rejectsPrebuilt(fixture: Fixture, expected: RegExp): Promise<void> {
  const attempted = { count: 0 };
  const trap = createServer((_request, response) => {
    attempted.count += 1;
    response.writeHead(500);
    response.end('AWS requests must not run for an invalid prebuilt');
  });
  await new Promise<void>((resolve, reject) => {
    trap.once('error', reject);
    trap.listen(0, '127.0.0.1', () => {
      trap.off('error', reject);
      resolve();
    });
  });
  try {
    const address = trap.address();
    assert.ok(address !== null && typeof address !== 'string');
    const result = await new Promise<{ readonly code: number; readonly text: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [cliOf(fixture.context), 'deploy', fixture.source, '--prebuilt'],
          {
            cwd: fixture.source,
            env: {
              ...process.env,
              ...fixture.environment,
              AWS_ENDPOINT_URL: `http://127.0.0.1:${String(address.port)}`,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        const chunks: Buffer[] = [];
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('invalid prebuilt did not fail before AWS access'));
        }, REQUEST_TIMEOUT_MS);
        child.stdout.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          resolve({ code: code ?? 1, text: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    assert.notEqual(result.code, 0, 'a changed prebuilt must not be deployed');
    assert.match(
      result.text,
      expected,
      'prebuilt must fail its local integrity/compatibility check',
    );
    assert.equal(attempted.count, 0, 'prebuilt validation must finish before any AWS API request');
  } finally {
    await new Promise<void>((resolve, reject) => {
      trap.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }
}

async function tampering(fixture: Fixture, receipt: FargateBuildReceipt): Promise<void> {
  const receiptPath = path.join(fargateDirectory(fixture.source), 'deployment.json');
  const original = await readFile(receiptPath, 'utf8');
  try {
    const raw = JSON.parse(original) as Record<string, unknown>;
    await writeJson(receiptPath, { ...raw, nodeAbi: 'invalid-abi' });
    await rejectsPrebuilt(fixture, /Node\.js version, ABI, or platform/u);
  } finally {
    await writeFile(receiptPath, original);
  }
  const size = (await stat(receipt.archivePath)).size;
  try {
    await appendFile(receipt.archivePath, 'corrupted-prebuilt-image');
    await rejectsPrebuilt(fixture, /integrity check/u);
  } finally {
    await truncate(receipt.archivePath, size);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: 'string' } }, strict: true });
  if (values.out === undefined) throw new Error('usage: check-aws.ts --out <directory>');
  const out = path.resolve(values.out);
  await mkdir(out, { recursive: true });
  say('packing published packages into a temporary monorepo');
  const prepared = await fixture(out);
  await withEnvironment(prepared.environment, async () => {
    say('building the native Linux image through the installed CLI without an AWS account');
    succeed(
      process.execPath,
      [cliOf(prepared.context), 'deploy', prepared.source, '--build-only'],
      prepared.source,
    );
    const receipt = await readFargateBuild({
      projectDir: prepared.source,
      settings: awsDeploySettings({
        region: 'us-east-1',
        compute: 'fargate',
        architecture: 'x86_64',
        cache: { backend: 'dynamodb' },
      }),
    });
    assert.equal(receipt.compute, 'fargate');
    assert.equal(receipt.platform, 'linux/amd64');
    assert.match(receipt.baseImageDigest, /^node@sha256:[a-f0-9]{64}$/u);
    assert.ok(receipt.staticFiles.length > 0, 'the build must carry immutable client assets');
    assert.equal(
      receipt.safeStaticBypass,
      false,
      'the fixture proxy must revoke unconditional CDN bypass',
    );
    const files = await readdir(receipt.nativeDirectory, { recursive: true, withFileTypes: true });
    assert.ok(
      files.some((file) => file.isFile() && file.name.endsWith('.node')),
      'the Linux native addon must travel with the image',
    );
    for (const file of files)
      if (file.isFile())
        await excludesSecrets(path.join(file.parentPath, file.name), prepared.sentinels);
    await excludesSecrets(receipt.archivePath, prepared.sentinels);
    await verifyFargateArchive(receipt);
    await nativeImage(receipt, prepared.context);
    say('checking that changed prebuilt metadata and image bytes fail before AWS access');
    await tampering(prepared, receipt);
    say(
      'published CLI, monorepo preparation, build secrets, Linux native dependency, ABI and prebuilt checks passed',
    );
  });
}

await main();
