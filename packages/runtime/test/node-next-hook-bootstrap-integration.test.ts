/* eslint-disable security/detect-non-literal-fs-filename -- CI-only fixtures stay under a fresh mkdtemp root and are removed in finally. */
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
const GUARD = new URL('../src/node-jwt-guard.ts', import.meta.url).href;
const BOOTSTRAP = new URL('../src/node-next-hook-bootstrap.ts', import.meta.url).href;
const HOOK = 'node_modules/next/dist/server/require-hook.js';
const RECORD = {
  schema: 1,
  profile: 'next-16.4.3-require-hook-v1',
  nodeVersion: '24.22.1',
  archivePath: HOOK,
  sha256: 'e82f0ceba88d025c725ea3062974ad9d7a54a892df8c34a525cb129202387db8',
  bytes: 3066,
};
const JWT_RECORD = {
  schema: 1,
  profile: 'next-16.4.3-jsonwebtoken-ncc-v1',
  nodeVersion: '24.22.1',
  archivePath: 'node_modules/next/dist/compiled/jsonwebtoken/index.js',
  sha256: '056c2dddba96faa35f4dc0740228a241990561290ff3bd5456c7c7dbc5a7a6b9',
  bytes: 121_051,
};
interface Options {
  readonly before?: string;
  readonly changed?: boolean;
  readonly install?: string;
  readonly aliases?: boolean;
  readonly edge?: boolean;
  readonly jwt?: boolean;
  readonly jwtChanged?: boolean;
}

async function copyJwt(directory: string, changed: boolean): Promise<void> {
  const jwt = path.join(directory, JWT_RECORD.archivePath);
  const semver = path.join(directory, 'node_modules/next/dist/lib/semver-noop.js');
  await mkdir(path.dirname(jwt), { recursive: true });
  await mkdir(path.dirname(semver), { recursive: true });
  await copyFile(require.resolve('next/dist/compiled/jsonwebtoken'), jwt);
  await copyFile(require.resolve('next/dist/lib/semver-noop'), semver);
  if (changed) await writeFile(jwt, `${await readFile(jwt, 'utf8')}\nglobalThis.changed=true;`);
}

/** Real Node/Next execution belongs only to the dedicated Linux CI lane. */
async function scenario(after: string, options: Options = {}): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'upwind-next-hook-'));
  try {
    const vendor = path.join(directory, 'node_modules/next');
    const server = path.join(directory, 'upwind/server.mjs');
    await mkdir(path.join(vendor, 'dist/server'), { recursive: true });
    await mkdir(path.dirname(server));
    await mkdir(path.join(directory, 'app'));
    await copyFile(require.resolve('next/dist/server/require-hook'), path.join(directory, HOOK));
    await copyFile(require.resolve('next/package.json'), path.join(vendor, 'package.json'));
    if (options.changed === true) {
      const filename = path.join(directory, HOOK);
      await writeFile(filename, `${await readFile(filename, 'utf8')}\nglobalThis.changed=true;`);
    }
    const aliases: { request: string; target: string }[] = [];
    if (options.aliases === true) {
      const styled = path.join(directory, 'node_modules/styled-jsx');
      await mkdir(styled);
      await writeFile(path.join(styled, 'package.json'), '{"main":"index.js"}');
      await writeFile(path.join(styled, 'index.js'), "module.exports={value:'styled'};");
      await writeFile(path.join(styled, 'style.js'), "module.exports={value:'style'};");
      aliases.push(
        { request: 'styled-jsx', target: 'node_modules/styled-jsx/index.js' },
        { request: 'styled-jsx/style', target: 'node_modules/styled-jsx/style.js' },
        { request: 'styled-jsx/style.js', target: 'node_modules/styled-jsx/style.js' },
      );
    }
    const sharedRuntimeEdges: { caller: string; specifier: string; target: string }[] = [];
    if (options.edge === true) {
      const target =
        'node_modules/next/dist/server/route-modules/pages/vendored/contexts/authored-context.js';
      await mkdir(path.dirname(path.join(directory, target)), { recursive: true });
      await writeFile(path.join(directory, target), "module.exports={value:'shared'};");
      await writeFile(
        path.join(directory, 'app/caller.cjs'),
        "module.exports=require('./authored-context.shared-runtime');",
      );
      sharedRuntimeEdges.push({
        caller: 'app/caller.cjs',
        specifier: './authored-context.shared-runtime',
        target,
      });
    }
    const config = { record: RECORD, aliases, sharedRuntimeEdges };
    if (options.jwt === true) await copyJwt(directory, options.jwtChanged === true);
    await writeFile(
      server,
      `import {createRequire,Module} from 'node:module';
import {installNodeJwtGuards} from ${JSON.stringify(GUARD)};
import {initializeNodeNextRequireHook} from ${JSON.stringify(BOOTSTRAP)};
const require=createRequire(import.meta.url);
const hook=new URL('../${HOOK}',import.meta.url).pathname;
const config=${JSON.stringify(config)};
const records=${JSON.stringify(options.jwt === true ? [JWT_RECORD] : [])};
${options.before ?? ''}
${options.install ?? 'installNodeJwtGuards(import.meta.url,records,config);'}
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

const APPLICATION_IO_HOOKS = `
const nodeCrypto=require('node:crypto');
const OriginalDate=Date,originalRandom=Math.random;
const originalBytes=nodeCrypto.randomBytes,originalFill=nodeCrypto.randomFillSync;
let ioCalls=0;
const appRandom=()=>{ioCalls++;return originalRandom();};
const appDate=Object.defineProperties(function Date(...args){
ioCalls++;return new.target===undefined?Reflect.apply(OriginalDate,undefined,args):Reflect.construct(OriginalDate,args,new.target);
},Object.getOwnPropertyDescriptors(OriginalDate));
appDate.now=()=>{ioCalls++;return OriginalDate.now();};
const appBytes=(...args)=>{ioCalls++;return Reflect.apply(originalBytes,nodeCrypto,args);};
const appFill=(...args)=>{ioCalls++;return Reflect.apply(originalFill,nodeCrypto,args);};
Math.random=appRandom;globalThis.Date=appDate;
Object.defineProperty(OriginalDate.prototype,'constructor',{value:appDate});
nodeCrypto.randomBytes=appBytes;nodeCrypto.randomFillSync=appFill;
const ioSlots=[[Math,'random'],[globalThis,'Date'],[OriginalDate.prototype,'constructor'],[nodeCrypto,'randomBytes'],[nodeCrypto,'randomFillSync']];
const savedIo=ioSlots.map(([owner,key])=>Object.getOwnPropertyDescriptor(owner,key));
const loadJwt=()=>require('../node_modules/next/dist/compiled/jsonwebtoken/index.js');
`;

const ASSERT_IO_RESTORED = `
for(let index=0;index<ioSlots.length;index++){
const [owner,key]=ioSlots[index],saved=savedIo[index],actual=Object.getOwnPropertyDescriptor(owner,key);
if(actual.value!==saved.value||actual.get!==saved.get||actual.set!==saved.set||actual.writable!==saved.writable||actual.configurable!==saved.configurable||actual.enumerable!==saved.enumerable)throw new Error('IO hook descriptor changed');
}
if(ioCalls!==0)throw new Error('application IO hook ran during protected initialization');
`;

describe.skipIf(!ENABLED)('fixed Next require-hook bootstrap (dedicated Linux CI)', () => {
  it('preserves Next IO hooks across cached loads and genuine protected JWT initialization', async () => {
    const result = await scenario(
      `${APPLICATION_IO_HOOKS}
require('node:path');const jwt=loadJwt();
${ASSERT_IO_RESTORED}
const token=jwt.sign({value:'native'},'authored-ci-key');
if(jwt.verify(token,'authored-ci-key').value!=='native')throw new Error('JWT mismatch');
ioCalls=0;Date.now();new Date();Date();Math.random();nodeCrypto.randomBytes(1);nodeCrypto.randomFillSync(Buffer.alloc(1));
if(ioCalls!==6)throw new Error('ordinary IO hooks were lost');
console.log('next-io-hooks');`,
      { jwt: true },
    );

    expect(result).toBe('next-io-hooks');
  });

  it('never invokes application IO getters during health checks or protected initialization', async () => {
    const result = await scenario(
      `${APPLICATION_IO_HOOKS}
let getterCalls=0;
for(let index=0;index<ioSlots.length;index++){
const [owner,key]=ioSlots[index],saved=savedIo[index];
Object.defineProperty(owner,key,{configurable:true,enumerable:saved.enumerable,get(){getterCalls++;return saved.value;}});
savedIo[index]=Object.getOwnPropertyDescriptor(owner,key);
}
require('node:path');const jwt=loadJwt();
${ASSERT_IO_RESTORED}
if(getterCalls!==0||typeof jwt.verify!=='function')throw new Error('IO getter ran');
console.log('opaque-next-io');`,
      { jwt: true },
    );

    expect(result).toBe('opaque-next-io');
  });

  it('restores every Next IO descriptor when fixed source validation fails', async () => {
    const result = await scenario(
      `${APPLICATION_IO_HOOKS}
let refused=false;try{loadJwt();}catch(error){refused=String(error).includes('qualified source changed');}
${ASSERT_IO_RESTORED}
if(!refused)throw new Error('changed JWT was not refused');
console.log('next-io-restored');`,
      { jwt: true, jwtChanged: true },
    );

    expect(result).toBe('next-io-restored');
  });

  it('still refuses changes to other Math methods with a qualified Next hook', async () => {
    await expect(scenario("Math.floor=()=>0;require('node:path');")).rejects.toThrow(
      'required builtin',
    );
  });

  it('preserves the original hook exports, default aliases and ordinary Node loads', async () => {
    const result = await scenario(
      `const value=require(hook);
if(value.hookPropertyMap.size!==3)throw new Error('alias count');
if(require('styled-jsx').value!=='styled')throw new Error('styled alias');
if(require('styled-jsx/style.js').value!=='style')throw new Error('style alias');
if(require('path')!==require('node:path'))throw new Error('builtin identity');
console.log('hook-and-sdk');`,
      { aliases: true },
    );

    expect(result).toBe('hook-and-sdk');
  });

  it('keeps an empty default alias Map when the optional package is absent', async () => {
    const result = await scenario(
      "if(require(hook).hookPropertyMap.size!==0)throw new Error('alias count');console.log('empty');",
    );

    expect(result).toBe('empty');
  });

  it('keeps cached builtin loads bounded while the public assertion still checks every path entry', async () => {
    const result = await scenario(
      `const earlier=require('node:path');let calls=0,error;
Object.defineProperty(Module._pathCache,'unused',{configurable:true,get(){calls+=1;throw new Error('customer getter ran');}});
try{boot.assertCachedLoad();if(require('node:path')!==earlier)throw new Error('cached identity');
try{boot.assert();}catch(value){error=value;}}
finally{delete Module._pathCache.unused;}
if(calls!==0||!String(error).includes('DATA string'))throw new Error('unsafe cached-load boundary');
console.log('bounded');`,
      {
        install: `const boot=initializeNodeNextRequireHook(import.meta.url,config);
boot.complete({load:Module._load,require:Module.prototype.require,compile:Module.prototype._compile});`,
      },
    );

    expect(result).toBe('bounded');
  });

  it.each([
    { prepare: '', load: "require.resolve('../app/missing.cjs');" },
    {
      prepare:
        "require('../app/caller.cjs');const caller=require.cache[require.resolve('../app/caller.cjs')];",
      load: "caller.require('./authored-context.shared-runtime');",
    },
  ])(
    'checks all path descriptors before either resolver delegation %#',
    async ({ prepare, load }) => {
      const result = await scenario(
        `${prepare}let calls=0,error;
Object.defineProperty(Module._pathCache,'unused',{configurable:true,get(){calls+=1;throw new Error('customer getter ran');}});
try{${load}}catch(value){error=value;}finally{delete Module._pathCache.unused;}
if(calls!==0||!String(error).includes('DATA string'))throw new Error('unsafe resolver boundary');
console.log('guarded');`,
        { edge: true },
      );

      expect(result).toBe('guarded');
    },
  );

  it('supports the exact shared-runtime edge and a target loaded earlier through Node', async () => {
    const result = await scenario(
      `const earlier=require('../node_modules/next/dist/server/route-modules/pages/vendored/contexts/authored-context');
const value=require('../app/caller.cjs');
if(value!==earlier||value.value!=='shared')throw new Error('shared target');
console.log('shared');`,
      { edge: true },
    );

    expect(result).toBe('shared');
  });

  it('refuses an unqualified shared-runtime request before the Next wrapper rewrites it', async () => {
    await expect(scenario("require('./unknown.shared-runtime');")).rejects.toThrow(
      'unqualified shared-runtime',
    );
  });

  it('refuses changed original hook bytes before evaluating them', async () => {
    await expect(scenario('', { changed: true })).rejects.toThrow('fixed hook source changed');
  });

  it('refuses a hook evaluated before trusted bootstrap', async () => {
    await expect(scenario('', { before: 'require(hook);' })).rejects.toThrow(
      'hook already evaluated',
    );
  });

  it.each([
    "require(hook).hookPropertyMap.set('unknown','/outside');",
    "require(hook).hookPropertyMap.delete('styled-jsx');",
    "require(hook).hookPropertyMap.set('styled-jsx','/outside');",
  ])('refuses a mutated alias Map: %s', async (change) => {
    await expect(scenario(`${change}require('node:path');`, { aliases: true })).rejects.toThrow(
      'alias',
    );
  });

  it('refuses hook cache eviction and explicit fixed-source reevaluation', async () => {
    await expect(scenario('delete require.cache[hook];require(hook);')).rejects.toThrow(
      'hook cache',
    );
    await expect(
      scenario("require.cache[hook]._compile('module.exports={}',hook);"),
    ).rejects.toThrow('hook');
  });

  it.each([
    "Module._resolveFilename=function(){return '/outside';};",
    'Module.prototype.require=function(){};',
    'Module._load=function(){};',
    'Module.prototype._compile=function(){};',
  ])('asserts explicit completed loader references: %s', async (change) => {
    await expect(
      scenario(`${change}boot.assert();`, {
        install: `const boot=initializeNodeNextRequireHook(import.meta.url,config);
boot.complete({load:Module._load,require:Module.prototype.require,compile:Module.prototype._compile});`,
      }),
    ).rejects.toThrow('loader chain');
  });

  it('blocks app CJS evaluation during provisional SDK setup and restores the original chain', async () => {
    const result = await scenario(
      `const boot=initializeNodeNextRequireHook(import.meta.url,config);
try{require(hook);throw new Error('unexpected success');}catch(error){if(!String(error).includes('app load'))throw error;}
boot.restore();
if(Module._resolveFilename!==beforeResolve||Module.prototype.require!==beforeRequire||require.cache[hook])throw new Error('restore');
console.log('restored');`,
      {
        before:
          'const beforeResolve=Module._resolveFilename,beforeRequire=Module.prototype.require;',
        install: '',
      },
    );

    expect(result).toBe('restored');
  });

  it('never invokes a replaced path.basename getter before checking the original Next wrapper', async () => {
    await expect(
      scenario(`Object.defineProperty(require('node:path'),'basename',{configurable:true,get(){throw new Error('customer getter ran');}});
require('./unknown.shared-runtime');`),
    ).rejects.toThrow('required builtin');
  });

  it('rejects an Array prototype index accessor without invoking it during its own assertion', async () => {
    const result = await scenario(
      `let calls=0,error;
Object.defineProperty(Array.prototype,'0',{configurable:true,set(){calls+=1;throw new Error('customer setter ran');}});
try{boot.assert();}catch(value){error=value;}finally{delete Array.prototype[0];}
if(calls!==0||!String(error).includes('builtin'))throw new Error('unsafe assertion');
console.log('getter-free');`,
      {
        install: `const boot=initializeNodeNextRequireHook(import.meta.url,config);
boot.complete({load:Module._load,require:Module.prototype.require,compile:Module.prototype._compile});`,
      },
    );

    expect(result).toBe('getter-free');
  });
});
