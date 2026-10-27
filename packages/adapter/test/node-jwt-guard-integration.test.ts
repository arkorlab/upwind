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
  profile: 'next-16.4.3-jsonwebtoken-ncc-v1',
  nodeVersion: '24.22.1',
  archivePath: 'node_modules/next/dist/compiled/jsonwebtoken/index.js',
  sha256: '056c2dddba96faa35f4dc0740228a241990561290ff3bd5456c7c7dbc5a7a6b9',
  bytes: 121_051,
};

/** Real loader/source integration: CI only; never part of local source-only controls. */
async function scenario(before: string, after: string, changed = false): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'upwind-jwt-guard-'));
  try {
    const vendor = path.join(directory, 'node_modules/next');
    const upwind = path.join(directory, 'upwind');
    await mkdir(path.join(vendor, 'dist/compiled/jsonwebtoken'), { recursive: true });
    await mkdir(path.join(vendor, 'dist/lib'), { recursive: true });
    await mkdir(upwind);
    const original = require.resolve('next/dist/compiled/jsonwebtoken');
    const jwt = path.join(vendor, 'dist/compiled/jsonwebtoken/index.js');
    await copyFile(original, jwt);
    await copyFile(
      require.resolve('next/dist/lib/semver-noop'),
      path.join(vendor, 'dist/lib/semver-noop.js'),
    );
    await copyFile(require.resolve('next/package.json'), path.join(vendor, 'package.json'));
    if (changed) await writeFile(jwt, `${await readFile(jwt, 'utf8')}\nglobalThis.changed=true;`);
    const server = path.join(upwind, 'server.mjs');
    await writeFile(
      server,
      `import {createRequire} from 'node:module';
import {installNodeJwtGuards} from ${JSON.stringify(GUARD)};
const require=createRequire(import.meta.url);
const filename=new URL('../node_modules/next/dist/compiled/jsonwebtoken/index.js',import.meta.url);
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

const LOAD = `const jwt=require(filename.pathname);`;

describe.skipIf(!ENABLED)('fixed Node 24.22.1 JWT evaluation guard (dedicated Linux CI)', () => {
  it('loads the original source and preserves sign, verify and decode', async () => {
    const result = await scenario(
      '',
      `${LOAD}
const token=jwt.sign({value:'native'},'authored-ci-key');
if(jwt.verify(token,'authored-ci-key').value!=='native')throw new Error('verify mismatch');
if(jwt.decode(token).value!=='native')throw new Error('decode mismatch');
console.log('unchanged-jwt');`,
    );

    expect(result).toBe('unchanged-jwt');
  });

  it('checks the actual compile source before executing it', async () => {
    await expect(scenario('', LOAD, true)).rejects.toThrow('qualified source changed');
  });

  it.each([
    ['AMD', `globalThis.define=Object.assign(()=>{}, {amd:{}});`],
    ['inherited AMD', `Object.getPrototypeOf(globalThis).define=()=>{};`],
    ['Function metadata', `Function.prototype.authoredChanged=true;`],
    ['builtin export', `require('node:util').inherits=()=>{};`],
    ['Buffer alias', `globalThis.Buffer=function ReplacementBuffer(){};`],
    ['CommonJS wrapper', `require('node:module').wrapper[0]+='globalThis.define=()=>{};';`],
  ])('checks %s after preceding application initialization', async (_name, mutation) => {
    await expect(scenario('', `${mutation}\n${LOAD}`)).rejects.toThrow(
      'Unsupported Node JWT initialization',
    );
  });

  it('rejects application getters without invoking them', async () => {
    const result = await scenario(
      '',
      `let calls=0;
Object.defineProperty(globalThis,'define',{get(){calls++;return undefined;},configurable:true});
let refused=false;
try {${LOAD}} catch(error){refused=String(error).includes('Unsupported Node JWT initialization');}
if(!refused||calls!==0)throw new Error('getter executed or initialization accepted');
console.log('getter-refused');`,
    );

    expect(result).toBe('getter-refused');
  });

  it('refuses an already evaluated dependency', async () => {
    await expect(scenario(LOAD, '')).rejects.toThrow('qualified source already evaluated');
  });

  it('keeps the check on cache eviction and subsequent evaluation', async () => {
    await expect(
      scenario(
        '',
        `${LOAD}
delete require.cache[filename.pathname];
globalThis.define=()=>{};
require(filename.pathname);`,
      ),
    ).rejects.toThrow('Unsupported Node JWT initialization');
  });
});
