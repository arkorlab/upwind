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
const REALM = new URL('../../runtime/src/node-jwt-realm.ts', import.meta.url).href;
const RECORD = {
  schema: 1,
  profile: 'next-16.4.3-jsonwebtoken-ncc-v1',
  nodeVersion: process.versions.node,
  archivePath: 'node_modules/next/dist/compiled/jsonwebtoken/index.js',
  sha256: '056c2dddba96faa35f4dc0740228a241990561290ff3bd5456c7c7dbc5a7a6b9',
  bytes: 121_051,
};

/** Real loader/source integration: CI only; never part of local source-only controls. */
async function scenario(
  before: string,
  after: string,
  changed = false,
  semverChanged = false,
): Promise<string> {
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
    if (semverChanged) {
      const semver = path.join(vendor, 'dist/lib/semver-noop.js');
      await writeFile(semver, `${await readFile(semver, 'utf8')}\nglobalThis.semverChanged=true;`);
    }
    const server = path.join(upwind, 'server.mjs');
    await writeFile(
      server,
      `import {createRequire} from 'node:module';
import {installNodeJwtGuards} from ${JSON.stringify(GUARD)};
const require=createRequire(import.meta.url);
const filename=new URL('../node_modules/next/dist/compiled/jsonwebtoken/index.js',import.meta.url);
const semverFilename=new URL('../node_modules/next/dist/lib/semver-noop.js',import.meta.url);
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
const APPLICATION_ERROR_HOOKS = `
const inspectKey=Symbol.for('nodejs.util.inspect.custom');
let hookCalls=0;
const appPrepare=()=>{hookCalls++;return 'application-stack';};
const appInspect=()=>{hookCalls++;return 'application-inspect';};
Object.defineProperty(Error,'prepareStackTrace',{value:appPrepare,writable:true,configurable:true,enumerable:false});
Object.defineProperty(Error.prototype,inspectKey,{value:appInspect,writable:true,configurable:true,enumerable:false});
`;

describe.skipIf(!ENABLED)('fixed Node JWT evaluation guard (dedicated Linux CI)', () => {
  it.runIf(process.versions.node === '26.13.0')(
    'refuses a supplied SlowBuffer accessor without invoking it',
    async () => {
      await expect(
        scenario(
          `Object.defineProperty(require('node:buffer'),'SlowBuffer',{configurable:true,get(){throw new Error('application getter ran');}});`,
          '',
        ),
      ).rejects.toThrow('unexpected SlowBuffer export');
    },
  );

  it('rejects a record for the other reviewed Node release', async () => {
    const other = process.versions.node === '24.22.1' ? '26.13.0' : '24.22.1';
    await expect(scenario(`record.nodeVersion=${JSON.stringify(other)};`, '')).rejects.toThrow(
      'invalid build-produced source record',
    );
  });

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

  it('preserves application error hooks around genuine protected initialization', async () => {
    const result = await scenario(
      '',
      `${APPLICATION_ERROR_HOOKS}
${LOAD}
if(hookCalls!==0||Error.prepareStackTrace!==appPrepare||Error.prototype[inspectKey]!==appInspect)throw new Error('protected initialization changed application hooks');
const token=jwt.sign({value:'native'},'authored-ci-key');
if(jwt.verify(token,'authored-ci-key').value!=='native')throw new Error('verify mismatch');
if(new Error('visible').stack!=='application-stack')throw new Error('ordinary stack formatter was lost');
if(require('node:util').inspect(new Error('visible'))!=='application-inspect')throw new Error('ordinary inspect hook was lost');
console.log('application-error-hooks');`,
    );

    expect(result).toBe('application-error-hooks');
  });

  it('restores application error hooks when protected source validation throws', async () => {
    const result = await scenario(
      '',
      `${APPLICATION_ERROR_HOOKS}
let refused=false;
try {${LOAD}}catch(error){refused=String(error).includes('qualified source changed');}
if(!refused||hookCalls!==0||Error.prepareStackTrace!==appPrepare||Error.prototype[inspectKey]!==appInspect)throw new Error('throw path lost application hooks');
console.log('error-hooks-restored');`,
      true,
    );

    expect(result).toBe('error-hooks-restored');
  });

  it.each(['get', 'value'])(
    'does not invoke inherited descriptor %s getters during protected cleanup',
    async (key) => {
      const before = `import {captureNodeJwtRealm,assertNodeJwtRealm,withNodeJwtRealmErrorHooks} from ${JSON.stringify(REALM)};
const isolatedRealm=captureNodeJwtRealm(globalThis,process);`;
      const result = await scenario(
        before,
        `${APPLICATION_ERROR_HOOKS}
let getterReads=0;
const appGetter=()=>{getterReads++;return appPrepare;};
if(${JSON.stringify(key)}==='value')Object.defineProperty(Error,'prepareStackTrace',{get:appGetter,configurable:true,enumerable:false});
const savedPrepare=Object.getOwnPropertyDescriptor(Error,'prepareStackTrace');
let inheritedReads=0;
Object.defineProperty(Object.prototype,${JSON.stringify(key)},{__proto__:null,get(){inheritedReads++;return undefined;},configurable:true});
let refused=false;
try {withNodeJwtRealmErrorHooks(isolatedRealm,()=>assertNodeJwtRealm(isolatedRealm));}catch(error){refused=String(error).includes('Unsupported Node JWT initialization');}
delete Object.prototype[${JSON.stringify(key)}];
const restored=Object.getOwnPropertyDescriptor(Error,'prepareStackTrace');
if(!refused||inheritedReads!==0||getterReads!==0||hookCalls!==0||restored.value!==savedPrepare.value||restored.get!==savedPrepare.get||Error.prototype[inspectKey]!==appInspect)throw new Error('descriptor cleanup invoked an inherited getter or lost hooks');
console.log('descriptor-cleanup-safe');`,
      );

      expect(result).toBe('descriptor-cleanup-safe');
    },
  );

  it('checks the actual compile source before executing it', async () => {
    await expect(scenario('', LOAD, true)).rejects.toThrow('qualified source changed');
  });

  it('checks the actual semver source before executing it', async () => {
    await expect(scenario('', LOAD, false, true)).rejects.toThrow('qualified source changed');
  });

  it('accepts the genuine dependency cache and genuine Node cache eviction', async () => {
    const result = await scenario(
      '',
      `
require(semverFilename.pathname);
${LOAD}
delete require.cache[filename.pathname];
const second=require(filename.pathname);
delete require.cache[filename.pathname];
delete require.cache[semverFilename.pathname];
const third=require(filename.pathname);
if(typeof second.sign!=='function'||typeof third.sign!=='function')throw new Error('genuine re-evaluation changed');
console.log('genuine-semver-cache');`,
    );

    expect(result).toBe('genuine-semver-cache');
  });

  it.each([
    [
      'replacement module',
      `require.cache[semverFilename.pathname]={exports:{satisfies(){calls++;return true;}},loaded:true};`,
    ],
    [
      'replacement namespace',
      `require(semverFilename.pathname);require.cache[semverFilename.pathname].exports=Object.defineProperty({},'satisfies',{get(){calls++;return ()=>true;}});`,
    ],
    [
      'loaded getter',
      `require(semverFilename.pathname);Object.defineProperty(require.cache[semverFilename.pathname],'loaded',{get(){calls++;return true;},configurable:true});`,
    ],
  ])('refuses an unobserved semver %s without calling it', async (_kind, mutate) => {
    const result = await scenario(
      '',
      `
let calls=0;
${mutate}
let refused=false;
try {${LOAD}} catch(error){refused=String(error).includes('Unsupported Node JWT semver state');}
if(!refused||calls!==0)throw new Error('unobserved semver value was called or accepted');
console.log('semver-refused');`,
    );

    expect(result).toBe('semver-refused');
  });

  it('refuses a changed default Module.load before it can bypass dependency compilation', async () => {
    const result = await scenario(
      '',
      `
const Module=require('node:module'),load=Module.prototype.load;
let bypassed=false;
Module.prototype.load=function(file){
 if(file===semverFilename.pathname){bypassed=true;this.exports={satisfies:()=>true};this.loaded=true;return;}
 return Reflect.apply(load,this,[file]);
};
let refused=false;
try {${LOAD}} catch(error){refused=String(error).includes('Unsupported Node');}
if(!refused||bypassed)throw new Error('custom load bypassed the compile guard');
console.log('load-refused');`,
    );

    expect(result).toBe('load-refused');
  });

  it('blocks same-path load-cache prepopulation before qualified initialization', async () => {
    const result = await scenario(
      '',
      `
const scoped=require('node:module').createRequire(filename.pathname);
let refused=false;
try {scoped('crypto')} catch(error){refused=String(error).includes('Unsupported fixed Node load scope');}
if(!refused)throw new Error('same-path prepopulation was accepted');
${LOAD}
if(typeof jwt.sign!=='function')throw new Error('subsequent genuine initialization failed');
console.log('history-fenced');`,
    );

    expect(result).toBe('history-fenced');
  });

  it('preserves require tracing and rechecks state after its end subscribers', async () => {
    const result = await scenario(
      '',
      `
const channel=require('node:diagnostics_channel').tracingChannel('module.require');
let observed=0;
channel.subscribe({end(context){if(context.id==='next/dist/lib/semver-noop')observed++;}});
${LOAD}
if(observed===0||typeof jwt.verify!=='function')throw new Error('tracing was suppressed');
console.log('tracing-preserved');`,
    );

    expect(result).toBe('tracing-preserved');
    await expect(
      scenario(
        '',
        `
require('node:diagnostics_channel').tracingChannel('module.require').subscribe({
 end(context){if(context.id==='next/dist/lib/semver-noop')globalThis.define=()=>{};}
});
${LOAD}`,
      ),
    ).rejects.toThrow('Unsupported Node');
  });

  it.each(['buffer', 'crypto', 'stream', 'util'])(
    'refuses a cached bare %s replacement',
    async (name) => {
      await expect(
        scenario('', `require.cache[${JSON.stringify(name)}]={exports:{}};\n${LOAD}`),
      ).rejects.toThrow('Unsupported Node JWT initialization');
    },
  );

  it('refuses a bare builtin cache getter without invoking it', async () => {
    const result = await scenario(
      '',
      `
let calls=0;
Object.defineProperty(require.cache,'crypto',{get(){calls++;return {exports:{}};},configurable:true});
let refused=false;
try {${LOAD}} catch(error){refused=String(error).includes('Unsupported Node JWT initialization');}
if(!refused||calls!==0)throw new Error('builtin cache getter was called or accepted');
console.log('cache-getter-refused');`,
    );

    expect(result).toBe('cache-getter-refused');
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
    await expect(scenario(LOAD, '')).rejects.toThrow('semver cache populated before observation');
  });

  it('refuses an evaluated JWT source even when its dependency cache was cleared', async () => {
    await expect(
      scenario(`${LOAD}\ndelete require.cache[semverFilename.pathname];`, ''),
    ).rejects.toThrow('qualified source already evaluated');
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
