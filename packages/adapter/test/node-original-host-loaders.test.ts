import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { rolldown, type OutputChunk } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { identifier, stringOf, walk } from '../src/native-ast.ts';
import { originalHostLoadersPlugin } from '../src/node-original-host-loaders.ts';
import { originalNodeHostLoaderSites } from '../src/node-original-host-proof.ts';

const MARKER = '__UPWIND_ORIGINAL_HOST_LOADER__';

function digest(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

describe('retained original CommonJS host-loader sites', () => {
  let directory: string;
  let entry: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-original-host-sites-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
    entry = path.join(directory, 'entry.cjs');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function bundleSource(
    source: string,
    sources?: Parameters<typeof originalHostLoadersPlugin>[0],
  ) {
    await writeFile(entry, source);
    const originals = sources ?? new Map([[entry, { file: entry, sha256: digest(source) }]]);
    const proof = originalHostLoadersPlugin(originals);
    await using build = await rolldown({
      input: entry,
      platform: 'node',
      plugins: [proof.plugin],
    });
    const { output } = await build.generate({
      format: 'cjs',
      codeSplitting: false,
      minify: { compress: true, mangle: false, codegen: { removeWhitespace: true } },
    });
    const chunk = output.find((item): item is OutputChunk => item.type === 'chunk');
    if (chunk === undefined) throw new Error('The authored source produced no analysis chunk');
    return { chunk, proof };
  }

  it.each([
    ['literal branch', "if(false)module.require('./unused.js');module.exports=42;"],
    ['unused function', "function unused(){module.require('./unused.js')}module.exports=42;"],
    ['unused closure', 'const unused=name=>module.constructor._load(name);module.exports=42;'],
    ['dead expression', "module.exports=false?module.require('./unused.js'):42;"],
    ['unused host-returning function', 'function unused(){return module}module.exports=42;'],
    ['unused host-accepting call', 'function unused(){consume(module)}module.exports=42;'],
    ['dead instance compiler', 'if(false)module._compile(source,file);module.exports=42;'],
    [
      'unused host-child function',
      'function unused(){return module.children[0]}module.exports=42;',
    ],
    ['dead search-path mutation', "if(false)module.paths.unshift('/another');module.exports=42;"],
    ['unused search-path replacement', 'function unused(){module.paths=[]}module.exports=42;'],
  ])('does not refuse a %s removed by compression', async (_title, source) => {
    const { chunk, proof } = await bundleSource(source);

    expect(proof.retained(chunk)).toStrictEqual([]);
    expect(chunk.code).not.toContain(MARKER);
  });

  it.each([
    ['host require', 'module.exports=name=>module.require(name);'],
    ['instance compiler', 'exports.compile=(source,file)=>module._compile(source,file);'],
    ['host constructor', 'exports.load=name=>module.constructor._load(name);'],
    ['computed constructor', "exports.load=name=>module['constructor']._load(name);"],
    ['host parent', 'exports.load=name=>module.parent.constructor._load(name);'],
    ['host alias', 'const current=module;exports.load=name=>current.constructor._load(name);'],
    [
      'destructured host',
      'const {constructor:Loader}=module;exports.load=name=>Loader._load(name);',
    ],
    [
      'computed destructured host',
      "const {['constructor']:Loader}=module;exports.load=name=>Loader._load(name);",
    ],
    ['host rest copy', 'const {...current}=module;exports.load=name=>current.require(name);'],
    ['host rebinding', 'let current={};current=module;exports.load=name=>current.require(name);'],
    ['unknown member', 'exports.load=(name,value)=>module[name](value);'],
    ['host loader assignment', 'module.require=globalThis.custom;module.exports=42;'],
    ['host loader deletion', 'delete module.require;module.exports=42;'],
    ['host loader update', 'module.require++;module.exports=42;'],
    [
      'destructured assignment',
      'let Loader;({constructor:Loader}=module);exports.load=name=>Loader._load(name);',
    ],
  ])('records only the surviving original %s before wrapper shadowing', async (_title, source) => {
    const { chunk, proof } = await bundleSource(source);
    const sites = proof.retained(chunk);
    const identities = sites.map((site) => {
      return {
        file: site.file,
        importer: site.importer,
        sha256: site.sha256,
        analysisSha256: site.analysisSha256,
      };
    });

    expect(identities).toStrictEqual([
      { file: entry, importer: entry, sha256: digest(source), analysisSha256: digest(source) },
    ]);
    expect(sites.every((site) => source.slice(site.start, site.end).length > 0)).toBe(true);
    await expect(readFile(entry, 'utf8')).resolves.toBe(source);
  });

  it.each([
    ['property export', 'exports.host=module;'],
    ['module export', 'module.exports=module;'],
    ['returned host', 'exports.getHost=()=>module;'],
    ['unknown call', 'exports.result=consume(module);'],
    ['aliased host', 'const current=module;exports.host=current;'],
    ['returned parent', 'exports.getHost=()=>module.parent;'],
    ['host array', 'exports.hosts=[module];'],
    ['host object', 'exports.hosts={current:module};'],
    ['shorthand host', 'exports.hosts={module};'],
    ['destructured parent', 'const {parent}=module;exports.host=parent;'],
    ['destructured children', 'const {children}=module;exports.hosts=children;'],
    ['exported children', 'exports.hosts=module.children;'],
    ['indexed child loader', 'exports.load=name=>module.children[0].require(name);'],
    ['child array alias', 'const children=module.children;exports.host=children[0];'],
    ['child array mutation', 'module.children.length=0;module.exports=42;'],
  ])(
    'records a retained %s without relying on compiler parameter names',
    async (_title, source) => {
      const { chunk, proof } = await bundleSource(source);
      const retained = proof.retained(chunk);

      expect(retained.length).toBeGreaterThan(0);
      expect(retained.every((site) => site.sha256 === digest(source))).toBe(true);
      await expect(readFile(entry, 'utf8')).resolves.toBe(source);
    },
  );

  it.each([
    ['prepend', "module.paths.unshift('/another');module.exports=42;"],
    ['replacement', 'module.paths=[];module.exports=42;'],
    ['index write', "module.paths[0]='/another';module.exports=42;"],
    ['length write', 'module.paths.length=0;module.exports=42;'],
    ['export', 'exports.paths=module.paths;'],
    ['array alias', "const paths=module.paths;paths.push('/another');module.exports=42;"],
    ['destructuring', "const {paths}=module;paths.push('/another');module.exports=42;"],
    ['parent mutation', "module.parent.paths.unshift('/another');module.exports=42;"],
    ['deletion', 'delete module.paths;module.exports=42;'],
    ['loop assignment', 'for(module.paths of values){}module.exports=42;'],
    ['pattern assignment', '({paths:module.paths}=value);module.exports=42;'],
  ])('tracks a retained loader search-path %s as unresolved authority', async (_title, source) => {
    const { chunk, proof } = await bundleSource(source);

    expect(proof.retained(chunk).length).toBeGreaterThan(0);
    await expect(readFile(entry, 'utf8')).resolves.toBe(source);
  });

  it.each([
    ['metadata', 'exports.filename=module.filename;'],
    ['ordinary exports', 'module.exports={value:42};'],
    ['destructured exports', 'const {exports:target}=module;target.value=42;'],
    ['quoted exports', "const {'exports':target}=module;target.value=42;"],
    ['parameter shadow', 'module.exports=module=>module.constructor._load();'],
    [
      'local module',
      'const module={constructor:{_load:()=>42}};exports.value=module.constructor._load();',
    ],
    [
      'compiler name lookalike',
      'const __commonJS=cb=>cb({}, {constructor:{_load:()=>42}});__commonJS((exports,module)=>{exports.value=module.constructor._load()});',
    ],
    ['top-level return', 'module.exports={value:42};return;'],
    ['host type metadata', 'exports.type=typeof module;'],
    ['aliased metadata', 'const current=module;exports.filename=current.filename;'],
    ['parent metadata', 'exports.parentFile=module.parent.filename;'],
    ['global host metadata', 'exports.filename=globalThis.module.filename;'],
    ['ignored host read', 'module;module.exports=42;'],
    ['child-count metadata', 'exports.count=module.children.length;'],
    ['path-count metadata', 'exports.count=module.paths.length;'],
    ['first search-path metadata', 'exports.first=module.paths[0];'],
    ['computed search-path metadata', "exports.first=module.paths['0'];"],
    ['aliased host path metadata', 'const current=module;exports.count=current.paths.length;'],
    [
      'shadowed path state',
      "const module={paths:[]};module.paths.unshift('/local');exports.value=42;",
    ],
    ['parameter path state', "exports.run=module=>module.paths.unshift('/local');"],
  ])('leaves genuine local shadows and %s unmarked', async (_title, source) => {
    const { chunk, proof } = await bundleSource(source);

    expect(proof.retained(chunk)).toStrictEqual([]);
    expect(chunk.code).not.toContain(MARKER);
  });

  it.each([
    ['direct', "process.dlopen(module,'./addon.node');module.exports=42;"],
    ['process alias', "const proc=process;proc.dlopen(module,'./addon.node');module.exports=42;"],
    ['method alias', "const {dlopen}=process;dlopen(module,'./addon.node');module.exports=42;"],
  ])(
    'leaves the %s dlopen operand to the independent native classifier',
    async (_title, source) => {
      const { chunk, proof } = await bundleSource(source);

      expect(proof.retained(chunk)).toStrictEqual([]);
    },
  );

  it('does not exempt a user-defined dlopen method that receives the host object', async () => {
    const source = 'const process={dlopen:consume};exports.value=process.dlopen(module);';
    const { chunk, proof } = await bundleSource(source);

    expect(proof.retained(chunk)).toHaveLength(1);
  });

  it.each(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.cts', '.mts'])(
    'checks the original graph executable suffix %s before wrapper generation',
    async (suffix) => {
      entry = path.join(directory, `entry${suffix}`);
      const source = 'exports.compile=(source,file)=>module._compile(source,file);';
      const { chunk, proof } = await bundleSource(source);

      expect(proof.retained(chunk)).toHaveLength(1);
    },
  );

  it('lowers authored TypeScript for analysis while keeping physical source bytes', async () => {
    entry = path.join(directory, 'entry.cts');
    const source = 'const value: number=1;exports.value=value;';
    const { chunk, proof } = await bundleSource(source);

    expect(proof.retained(chunk)).toStrictEqual([]);
    await expect(readFile(entry, 'utf8')).resolves.toBe(source);
  });

  it.each([
    [
      'ambient declaration',
      'declare const module:{require:(name:string)=>unknown};exports.load=(name:string)=>module.require(name);',
    ],
    ['cast', 'exports.load=(name:string)=>(module as any).constructor._load(name);'],
    ['enum initializer', 'enum Value { Native=module.require("./unowned") }exports.Value=Value;'],
  ])(
    'binds retained TypeScript %s sites to transformed offsets and original SHA',
    async (_name, source) => {
      entry = path.join(directory, 'entry.cts');
      const { chunk, proof } = await bundleSource(source);
      const retained = proof.retained(chunk);

      expect(retained.length).toBeGreaterThan(0);
      expect(
        retained.every(
          (site) => site.sha256 === digest(source) && site.analysisSha256 !== site.sha256,
        ),
      ).toBe(true);
      await expect(readFile(entry, 'utf8')).resolves.toBe(source);
    },
  );

  it('rejects the reserved prefix on a retained CommonJS TypeScript input', async () => {
    entry = path.join(directory, 'entry.cts');

    await expect(bundleSource(`exports.marker='${MARKER}';`)).rejects.toThrow(
      'Reserved original host analysis marker',
    );
  });

  it('retains distinct nested sites without overlapping source rewrites', async () => {
    const source = 'module.exports=name=>module.require(module.require(name));';
    const { chunk, proof } = await bundleSource(source);
    const operations = proof.retained(chunk).map((site) => source.slice(site.start, site.end));

    expect(operations).toStrictEqual(['module.require', 'module.require']);
    await expect(readFile(entry, 'utf8')).resolves.toBe(source);
  });

  it('binds exact source positions after Unicode without changing the physical source', async () => {
    const source = "exports.label='😀日本語';exports.load=name=>module.require(name);";
    const sites = originalNodeHostLoaderSites(entry, source);
    const { chunk, proof } = await bundleSource(source);
    const retained = proof.retained(chunk);

    expect(sites.map((site) => source.slice(site.start, site.end))).toStrictEqual([
      'module.require',
    ]);
    expect(retained.map((site) => source.slice(site.start, site.end))).toStrictEqual([
      'module.require',
    ]);
    await expect(readFile(entry, 'utf8')).resolves.toBe(source);
  });

  it('keeps original and linked analysis source hashes separate', async () => {
    const source = 'exports.load=name=>module.require(name);';
    const sha256 = digest('the physical source before reviewed graph links');
    const originals = new Map([[entry, { file: entry, sha256 }]]);
    const { chunk, proof } = await bundleSource(source, originals);
    const site = proof.retained(chunk)[0];

    expect({ physical: site?.sha256, analysis: site?.analysisSha256 }).toStrictEqual({
      physical: sha256,
      analysis: digest(source),
    });
  });

  it('refuses a source-proven host operation without a registered physical source', async () => {
    await expect(
      bundleSource('exports.load=name=>module.require(name);', new Map()),
    ).rejects.toThrow('no physical source identity');
  });

  it('rejects a reserved source marker before a caller can forge retained provenance', async () => {
    const source = `module.exports='${MARKER}';`;

    await expect(bundleSource(source)).rejects.toThrow('Reserved original host analysis marker');
  });

  it('rejects a Unicode-escaped binding that would shadow and erase generated markers', async () => {
    const source = String.raw`const __UPWIND_ORI\u0047INAL_HOST_LOADER__=(_id,value)=>value;exports.host=module;`;

    await expect(bundleSource(source)).rejects.toThrow('Reserved original host analysis marker');
  });

  it('does not treat a JSON data string as an executable marker', async () => {
    await writeFile(path.join(directory, 'data.json'), JSON.stringify({ value: MARKER }));
    const { chunk, proof } = await bundleSource("module.exports=require('./data.json');");

    expect(proof.retained(chunk)).toStrictEqual([]);
  });

  it('refuses unregistered output markers', () => {
    const proof = originalHostLoadersPlugin(new Map());
    const code = `${MARKER}('forged',module.require(name));`;

    expect(() => proof.retained({ code })).toThrow('unregistered original host analysis marker');
  });

  it('refuses an escaped output marker reference', () => {
    const proof = originalHostLoadersPlugin(new Map());
    const code = `const escaped=${MARKER};module.exports=escaped;`;

    expect(() => proof.retained({ code })).toThrow('unregistered original host analysis marker');
  });

  it('refuses a malformed registered output marker', async () => {
    const { chunk, proof } = await bundleSource('exports.load=name=>module.require(name);');
    const marker = walk(parseAst(chunk.code)).find(
      (node) => node.type === 'CallExpression' && identifier(node.callee, MARKER),
    );
    const id = marker?.type === 'CallExpression' ? stringOf(marker.arguments[0]) : undefined;
    const code = `${MARKER}(${JSON.stringify(id)});`;

    expect(id).toBeTypeOf('string');
    expect(() => proof.retained({ code })).toThrow('Malformed or unregistered');
  });

  it('does not turn a failed source parse into an empty retained proof', async () => {
    await expect(bundleSource('function {')).rejects.toThrow('cannot parse an executable module');
  });
});
