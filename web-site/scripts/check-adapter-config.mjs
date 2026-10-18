import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const cases = ['unset', 'empty', 'explicit', 'vercel'];
const CHILD_TIMEOUT_MS = 15_000;

/** Each child loads both the source config and Next's installed configuration loader afresh. */
async function checkOne(name, explicitAdapter) {
  assert.ok(cases.includes(name), 'unknown adapter selection case');
  const raw = (await import(pathToFileURL(path.join(root, 'next.config.ts')).href)).default;
  const installed = require.resolve('@stayingupwind/adapter');
  const fallback = name === 'unset' || name === 'empty';
  assert.equal(raw.adapterPath, fallback ? installed : undefined, 'source config selection');
  const { default: loadConfig } = require('next/dist/server/config');
  const { PHASE_PRODUCTION_BUILD } = require('next/constants');
  const effective = await loadConfig(PHASE_PRODUCTION_BUILD, root, { silent: true });
  const expected = fallback ? installed : name === 'explicit' ? explicitAdapter : undefined;
  assert.equal(effective.adapterPath, expected, 'Next.js adapter selection');
  assert.equal(
    globalThis.__upwindSiteAdapterConfig,
    name === 'explicit' ? true : undefined,
    'the explicit adapter modifyConfig hook was not selected',
  );
  return {
    name,
    status: 'success',
    sourceAdapter: fallback ? 'project-installed' : 'omitted',
    effectiveAdapter: fallback
      ? 'project-installed'
      : name === 'explicit'
        ? 'explicit-environment'
        : 'none',
    explicitModifyConfigCalled: globalThis.__upwindSiteAdapterConfig === true,
  };
}

/** Retain all four results and a primary failure without running a build or contacting a host. */
async function main(output) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'website-adapter-config-'));
  const adapter = path.join(directory, 'adapter.mjs');
  const config = await readFile(path.join(root, 'next.config.ts'));
  const proof = {
    status: 'running',
    nextVersion: require('next/package.json').version,
    configSha256: createHash('sha256').update(config).digest('hex'),
    cases: [],
  };
  let failure;
  try {
    await writeFile(
      adapter,
      `export default {
  name: 'website-config-control',
  modifyConfig(config) {
    globalThis.__upwindSiteAdapterConfig = true;
    return config;
  }
};\n`,
    );
    for (const name of cases) {
      const env = { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' };
      delete env.NEXT_ADAPTER_PATH;
      delete env.VERCEL;
      if (name === 'empty') env.NEXT_ADAPTER_PATH = '';
      if (name === 'explicit') env.NEXT_ADAPTER_PATH = adapter;
      if (name === 'vercel') env.VERCEL = '1';
      try {
        const stdout = execFileSync(process.execPath, [script, '--case', name, adapter], {
          cwd: root,
          env,
          encoding: 'utf8',
          timeout: CHILD_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        });
        proof.cases.push(JSON.parse(stdout));
      } catch (error) {
        failure ??= error;
        proof.cases.push({ name, status: 'failed' });
      }
    }
    proof.status = failure === undefined ? 'success' : 'failed';
  } catch (error) {
    failure ??= error;
    proof.status = 'failed';
  } finally {
    try {
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(proof, null, 2)}\n`);
    } catch (error) {
      if (failure === undefined) failure = error;
      else console.error('Adapter selection proof could not also be saved.');
    }
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      if (failure === undefined) failure = error;
      else console.error('Adapter selection temporary files could not also be removed.');
    }
  }
  if (failure !== undefined) throw failure;
  console.log(`Website adapter selection: ${String(proof.cases.length)} cases passed.`);
}

if (process.argv[2] === '--case') {
  console.log(JSON.stringify(await checkOne(process.argv[3], process.argv[4])));
} else {
  assert.ok(process.argv[2] !== undefined, 'provide an output JSON path');
  await main(path.resolve(process.argv[2]));
}
