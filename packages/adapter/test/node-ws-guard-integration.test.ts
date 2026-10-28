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
  profile: 'next-16.4.3-ws-ncc-v1',
  nodeVersion: '24.22.1',
  archivePath: 'node_modules/next/dist/compiled/ws/index.js',
  sha256: 'af354cb13a11abe910cdbcb70943cb450b01b24f322026ae3f88d428d148395d',
  bytes: 45_840,
};
const JWT_RECORD = {
  schema: 1,
  profile: 'next-16.4.3-jsonwebtoken-ncc-v1',
  nodeVersion: '24.22.1',
  archivePath: 'node_modules/next/dist/compiled/jsonwebtoken/index.js',
  sha256: '056c2dddba96faa35f4dc0740228a241990561290ff3bd5456c7c7dbc5a7a6b9',
  bytes: 121_051,
};

/** CI-only actual dependency evaluation. These controls must never run in local source checks. */
async function scenario(after: string, changed = false): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'upwind-ws-guard-'));
  try {
    const vendor = path.join(directory, 'node_modules/next');
    const upwind = path.join(directory, 'upwind');
    for (const name of ['ws', 'jsonwebtoken']) {
      const target = path.join(vendor, 'dist/compiled', name);
      await mkdir(target, { recursive: true });
      await copyFile(require.resolve(`next/dist/compiled/${name}`), path.join(target, 'index.js'));
    }
    await mkdir(path.join(vendor, 'dist/lib'), { recursive: true });
    await copyFile(
      require.resolve('next/dist/lib/semver-noop'),
      path.join(vendor, 'dist/lib/semver-noop.js'),
    );
    await copyFile(require.resolve('next/package.json'), path.join(vendor, 'package.json'));
    await mkdir(upwind);
    const ws = path.join(vendor, 'dist/compiled/ws/index.js');
    if (changed) await writeFile(ws, `${await readFile(ws, 'utf8')}\nglobalThis.changed=true;`);
    const server = path.join(upwind, 'server.mjs');
    await writeFile(
      server,
      `import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {installNodeJwtGuards} from ${JSON.stringify(GUARD)};
const require=createRequire(import.meta.url);
const filename=new URL('../node_modules/next/dist/compiled/ws/index.js',import.meta.url);
const jwtFilename=new URL('../node_modules/next/dist/compiled/jsonwebtoken/index.js',import.meta.url);
installNodeJwtGuards(import.meta.url,[${JSON.stringify(RECORD)},${JSON.stringify(JWT_RECORD)}]);
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

const LOAD = 'const ws=require(filename.pathname);';

describe.skipIf(!ENABLED)('fixed Node 24.22.1 WS evaluation guard (dedicated Linux CI)', () => {
  it('loads unchanged WS and JWT through the same original CommonJS guard', async () => {
    const result = await scenario(`${LOAD}
if(typeof ws!=='function'||typeof ws.Receiver!=='function'||typeof ws.Sender!=='function')throw new Error('WS exports changed');
const jwt=require(jwtFilename.pathname);
const token=jwt.sign({value:'native'},'authored-ci-key');
if(jwt.verify(token,'authored-ci-key').value!=='native')throw new Error('JWT exports changed');
console.log('unchanged-ws-and-jwt');`);

    expect(result).toBe('unchanged-ws-and-jwt');
  });

  it('rejects changed physical WS bytes before evaluating them', async () => {
    await expect(scenario(LOAD, true)).rejects.toThrow('qualified source changed');
  });

  it.each(['crypto', 'events', 'http', 'https', 'net', 'stream', 'tls', 'url', 'zlib'])(
    'refuses a cached bare %s replacement',
    async (name) => {
      await expect(
        scenario(`require.cache[${JSON.stringify(name)}]={exports:{}};\n${LOAD}`),
      ).rejects.toThrow('Unsupported Node JWT initialization');
    },
  );

  it('refuses a bare builtin cache getter without invoking it', async () => {
    const result = await scenario(`
let calls=0;
Object.defineProperty(require.cache,'crypto',{get(){calls++;return {exports:{}};},configurable:true});
let refused=false;
try {${LOAD}} catch(error){refused=String(error).includes('Unsupported Node');}
if(!refused||calls!==0)throw new Error('builtin cache getter was called or accepted');
console.log('builtin-cache-getter-refused');`);

    expect(result).toBe('builtin-cache-getter-refused');
  });

  it.each([
    ['paths', `module.paths=['/authored/extra'];`],
    ['own require', `module.require=()=>({});`],
    [
      'parent metadata',
      `Object.defineProperty(module.parent,'filename',{get(){calls++;return '';},configurable:true});`,
    ],
  ])('binds its absence check to the actual Module %s', async (_name, mutation) => {
    const result = await scenario(`
let calls=0,changed=0;
Object.defineProperty(require.cache,filename.pathname,{
  get(){return undefined;},
  set(module){
    Object.defineProperty(require.cache,filename.pathname,{value:module,writable:true,enumerable:true,configurable:true});
    ${mutation}
    changed++;
  },
  configurable:true
});
let refused=false;
try {${LOAD}} catch(error){refused=String(error).includes('Unsupported Node WebSocket module context');}
if(!refused||changed!==1||calls!==0)throw new Error('different Module context was called or accepted');
console.log('module-context-refused');`);

    expect(result).toBe('module-context-refused');
  });

  it.each(['bufferutil', 'utf-8-validate'])(
    'refuses a newly resolvable %s without running it',
    async (target) => {
      const result = await scenario(`
await writeFile(new URL('../node_modules/${target}.js',import.meta.url),'globalThis.optionalExecuted=true;module.exports={};');
let refused=false;
try {${LOAD}} catch(error){refused=String(error).includes('optional WebSocket native target is present');}
if(!refused||globalThis.optionalExecuted)throw new Error('new optional target escaped');
console.log('optional-refused');`);

      expect(result).toBe('optional-refused');
    },
  );

  it.each([
    ['stream', 'Readable'],
    ['stream', 'Writable'],
    ['crypto', 'randomBytes'],
    ['crypto', 'createHash'],
    ['url', 'URL'],
    ['fs', 'realpathSync'],
  ])('rejects a %s.%s export getter without calling it', async (builtin, member) => {
    const result = await scenario(`
let calls=0;
Object.defineProperty(require('node:${builtin}'),${JSON.stringify(member)},{get(){calls++;return function Changed(){};},configurable:true});
let refused=false;
try {${LOAD}} catch(error){refused=String(error).includes('Unsupported Node');}
if(!refused||calls!==0)throw new Error('builtin getter was called or accepted');
console.log('getter-refused');`);

    expect(result).toBe('getter-refused');
  });

  it('rejects a path callback getter installed immediately before compilation', async () => {
    const result = await scenario(`
let calls=0;
const fs=require('node:fs'),read=fs.readFileSync;
fs.readFileSync=function(...args){
  const value=Reflect.apply(read,this,args);
  if(args[0]===filename.pathname){
    fs.readFileSync=read;
    Object.defineProperty(require('node:path'),'resolve',{get(){calls++;return ()=>'';},configurable:true});
  }
  return value;
};
let refused=false;
try {${LOAD}} catch(error){refused=String(error).includes('Unsupported Node');}
if(!refused||calls!==0)throw new Error('path getter was called or accepted');
console.log('path-getter-refused');`);

    expect(result).toBe('path-getter-refused');
  });

  it('rejects a global eval getter without invoking it', async () => {
    const result = await scenario(`
let calls=0;
Object.defineProperty(globalThis,'eval',{get(){calls++;return ()=>require;},configurable:true});
let refused=false;
try {${LOAD}} catch(error){refused=String(error).includes('Unsupported Node');}
if(!refused||calls!==0)throw new Error('eval getter was called or accepted');
console.log('eval-refused');`);

    expect(result).toBe('eval-refused');
  });

  it.each(['_stat', '_readPackage'])('rejects a changed %s backing callback', async (field) => {
    const result = await scenario(`
let calls=0;
require('node:module')[${JSON.stringify(field)}]=()=>{calls++;throw new Error('replacement callback');};
let refused=false;
try {${LOAD}} catch(error){refused=String(error).includes('Unsupported Node');}
if(!refused||calls!==0)throw new Error('resolver callback was called or accepted');
console.log('resolver-refused');`);

    expect(result).toBe('resolver-refused');
  });

  it('rejects a path cache getter without invoking it', async () => {
    const result = await scenario(`
let calls=0;
Object.defineProperty(require('node:module')._pathCache,'authored-unrelated',{get(){calls++;return '';},configurable:true});
let refused=false;
try {${LOAD}} catch(error){refused=String(error).includes('Unsupported Node');}
if(!refused||calls!==0)throw new Error('path cache getter was called or accepted');
console.log('cache-getter-refused');`);

    expect(result).toBe('cache-getter-refused');
  });

  it('rechecks optional absence after cache eviction', async () => {
    const result = await scenario(`${LOAD}
delete require.cache[filename.pathname];
await writeFile(new URL('../node_modules/bufferutil.js',import.meta.url),'globalThis.optionalExecuted=true;module.exports={};');
let refused=false;
try {require(filename.pathname)} catch(error){refused=String(error).includes('optional WebSocket native target is present');}
if(!refused||globalThis.optionalExecuted)throw new Error('reload bypassed the absence check');
console.log('reload-refused');`);

    expect(result).toBe('reload-refused');
  });

  it('rejects a thrown tracing Proxy without inspecting it, outside the fallback catch', async () => {
    const result = await scenario(`
const channel=require('node:diagnostics_channel').tracingChannel('module.require');
const prototype=Object.getPrototypeOf(channel),trace=prototype.traceSync;
let traps=0;
channel.subscribe({start(){}});
const thrown=new Proxy({}, {getOwnPropertyDescriptor(){traps++;throw new Error('proxy trap');}});
prototype.traceSync=function(fn,context,...args){
 if(context.id==='bufferutil')throw thrown;
 return Reflect.apply(trace,this,[fn,context,...args]);
};
let refused=false;
try {${LOAD}} catch(error){refused=String(error).includes('Unsupported fixed Node load scope');}
if(!refused||traps!==0)throw new Error('tracing Proxy was inspected or fallback adopted');
console.log('proxy-refused');`);

    expect(result).toBe('proxy-refused');
  });
});
