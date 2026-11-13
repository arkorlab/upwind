import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const ENABLED = process.env['UPWIND_NATIVE_FUNCTION_INTEGRATION'] === '1';
const require = createRequire(import.meta.url);
const GUARD = new URL('../../runtime/src/node-jwt-guard.ts', import.meta.url).href;
const RECORD = {
  schema: 1,
  profile: 'next-16.4.4-fast-jwt-ncc-v1',
  nodeVersion: process.versions.node,
  archivePath: 'node_modules/next/dist/compiled/fast-jwt/index.js',
  sha256: '8cc4cea3ed6b85a6771a2546bbb88dcd1ca21e6061d89057728d3da4ecccfabf',
  bytes: 131_737,
};

/** Real loader/source integration: CI only; never part of local source-only controls. */
async function scenario(before: string, after: string, changed = false): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'upwind-fast-jwt-guard-'));
  try {
    const vendor = path.join(directory, 'node_modules/next');
    const upwind = path.join(directory, 'upwind');
    await mkdir(path.join(vendor, 'dist/compiled/fast-jwt'), { recursive: true });
    await mkdir(upwind);
    const jwt = path.join(vendor, 'dist/compiled/fast-jwt/index.js');
    await copyFile(require.resolve('next-16-4-4/dist/compiled/fast-jwt'), jwt);
    await copyFile(require.resolve('next-16-4-4/package.json'), path.join(vendor, 'package.json'));
    if (changed) await writeFile(jwt, `${await readFile(jwt, 'utf8')}\nglobalThis.changed=true;`);
    const server = path.join(upwind, 'server.mjs');
    await writeFile(
      server,
      `import {createRequire} from 'node:module';
import {installNodeJwtGuards} from ${JSON.stringify(GUARD)};
const require=createRequire(import.meta.url);
const filename=new URL('../node_modules/next/dist/compiled/fast-jwt/index.js',import.meta.url);
const record=${JSON.stringify(RECORD)};
${before}
installNodeJwtGuards(import.meta.url,[record]);
${after}
`,
    );
    const { stdout } = await execute(process.execPath, [server], {
      env: { NODE_ENV: 'production' },
      timeout: 10_000,
      maxBuffer: 65_536,
    });
    return stdout.trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const LOAD = `const {createSigner,createVerifier}=require(filename.pathname);`;

describe.skipIf(!ENABLED)('fixed Node fast-jwt evaluation guard (dedicated Linux CI)', () => {
  it('loads the original source and signs and verifies preview data as Next.js does', async () => {
    const result = await scenario(
      '',
      `${LOAD}
const token=createSigner({key:'authored-ci-key',algorithm:'HS256',expiresIn:60_000})({data:'native'});
if(createVerifier({key:'authored-ci-key',algorithms:['HS256']})(token).data!=='native')
  throw new Error('verify mismatch');
console.log('unchanged-fast-jwt');`,
    );

    expect(result).toBe('unchanged-fast-jwt');
  });

  it('refuses changed source bytes before they are evaluated', async () => {
    await expect(scenario('', LOAD, true)).rejects.toThrow(
      'qualified source changed before evaluation',
    );
  });

  it.each(
    ['24.22.1', '24.22.3', '26.13.0', '26.13.1'].filter(
      (version) => version !== process.versions.node,
    ),
  )('rejects a record produced on the different reviewed Node %s', async (other) => {
    await expect(scenario(`record.nodeVersion=${JSON.stringify(other)};`, '')).rejects.toThrow(
      'invalid build-produced source record',
    );
  });

  it('refuses a record that names jsonwebtoken’s profile for fast-jwt’s bytes', async () => {
    await expect(scenario(`record.profile='next-16.4.3-jsonwebtoken-ncc-v1';`, '')).rejects.toThrow(
      'invalid fixed source profile',
    );
  });
});
