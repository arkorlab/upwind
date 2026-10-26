import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseAst } from 'rolldown/parseAst';
import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import { isNode, listOf } from '../src/lexical-scope.ts';
import { proveNodeManifests } from '../src/node-manifest-proof.ts';
import { certifyNodeManifestTemplateHelperImport } from '../src/node-manifest-template-helpers.ts';
import { assertNodeManifestTurbopackTemplateConsumer } from '../src/node-manifest-turbopack-templates.ts';
import { projectNodeManifestTurbopackFactory } from '../src/node-manifest-turbopack.ts';
import { manifestTemplateProofFixture } from './fixtures/node-manifest-turbopack-proof.ts';
import {
  manifestTemplateSource,
  projectedTemplateFixture,
} from './fixtures/node-manifest-turbopack-template.ts';

async function helperSource(role: 'RouteKind' | 'hoist'): Promise<string> {
  const relative = role === 'RouteKind' ? 'server/route-kind.js' : 'build/templates/helpers.js';
  const source = await readFile(new URL(import.meta.resolve(`next/dist/${relative}`)), 'utf8');
  const parsed: unknown = parseAst(source);
  assert(isNode(parsed));
  const node = listOf(parsed, 'body').find((value) => {
    return (
      isNode(value) &&
      value.type === (role === 'RouteKind' ? 'VariableDeclaration' : 'FunctionDeclaration')
    );
  });
  assert(isNode(node));
  return source.slice(node.start, node.end);
}

async function fixture(
  role: 'RouteKind' | 'hoist' = 'RouteKind',
  targetExtra = '',
  selector?: string,
  brackets = false,
) {
  const original = await projectedTemplateFixture('pages');
  const relative = role === 'RouteKind' ? '/server/route-kind.js' : '/build/templates/helpers.js';
  const known = original.imports.find((entry) => entry.file.endsWith(relative));
  assert(known !== undefined);
  const compact = role === 'RouteKind' ? 'k' : 'f';
  const namespace = role === 'RouteKind' ? '_routekind' : '_helpers';
  const imported = `runtimeContext.x(${jsLiteral(known.specifier)},()=>require(${jsLiteral(known.specifier)}))`;
  let code = original.projection.original.code.replace(imported, () => 'runtimeContext.i(2)');
  code = code.replaceAll(`${namespace}.${role}`, () => {
    const key = selector ?? compact;
    return brackets ? `${namespace}[${jsLiteral(key)}]` : `${namespace}.${key}`;
  });
  assert(code !== original.projection.original.code);
  const helper = `2,(ctx)=>{"use strict";${await helperSource(role)};ctx.s([${jsLiteral(compact)},()=>${role}]);${targetExtra}}`;
  code = `${code.slice(0, -2)},${helper}];`;
  const source = manifestTemplateSource(code);
  const projection = projectNodeManifestTurbopackFactory(source, 1);
  const selected = projectNodeManifestTurbopackFactory(source, 2, 'dependencies');
  const owner = Object.freeze({ identity: Symbol('authored template owner') });
  const target = {
    id: 'helper-factory',
    runtimeId: 'runtime',
    physicalId: 'actual-chunk',
    projection: selected,
    imports: [] as { specifier: string; target: string }[],
  };
  const consumer = {
    id: 'route-factory',
    runtimeId: 'runtime',
    physicalId: 'actual-chunk',
    projection,
    imports: projection.imports.map((edge) => {
      return {
        specifier: edge.specifier,
        target: edge.targetId === 2 ? target.id : edge.specifier,
      };
    }),
  };
  const physical = {
    id: 'actual-chunk',
    file: '/fixture/server/chunks/page.js',
    source,
    imports: [],
  };
  const proofInput = { owner, consumer, target, physical, specifier: 'turbopack:2' };
  const helperImport = certifyNodeManifestTemplateHelperImport(proofInput);
  assert(helperImport !== undefined);
  const descriptor = {
    specifier: 'turbopack:2',
    file: physical.file,
    sha256: source.sha256,
    helper: helperImport,
  };
  const input = {
    ...original,
    helperOwner: owner,
    projection,
    imports: [...original.imports.filter((entry) => entry !== known), descriptor],
  };
  return { input, descriptor, owner, target, consumer, physical, proofInput, known };
}

describe('opaque selected Pages helper imports', () => {
  let directory: string;

  beforeEach(async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'upwind-template-helper-'));
    directory = await realpath(temporary);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each(['RouteKind', 'hoist'] as const)(
    'normalizes a proved compact %s member without forging its physical source',
    async (role) => {
      const own = await fixture(role);
      const proof = await assertNodeManifestTurbopackTemplateConsumer(own.input);

      expect(proof.kind).toBe('pages');
      expect(own.descriptor.file).toBe('/fixture/server/chunks/page.js');
      expect(own.descriptor.sha256).toBe(own.physical.source.sha256);
    },
  );

  it.each(['RouteKind', 'hoist'] as const)(
    'authenticates a bracket compact %s selector through its original selected export',
    async (role) => {
      const own = await fixture(role, '', undefined, true);

      await expect(assertNodeManifestTurbopackTemplateConsumer(own.input)).resolves.toMatchObject({
        kind: 'pages',
      });
      expect(own.descriptor.sha256).toBe(own.physical.source.sha256);
    },
  );

  it('refuses an unproved bracket helper selector and a copied helper identity', async () => {
    const wrong = await fixture('hoist', '', 'other', true);
    const copied = await fixture('hoist', '', undefined, true);
    copied.descriptor.helper = { ...copied.descriptor.helper };

    await expect(assertNodeManifestTurbopackTemplateConsumer(wrong.input)).rejects.toThrow(
      'unrecognized external import',
    );
    await expect(assertNodeManifestTurbopackTemplateConsumer(copied.input)).rejects.toThrow(
      'changed template helper import',
    );
  });

  it('preserves the unchanged direct pinned Next import path', async () => {
    const input = await projectedTemplateFixture('pages');

    await expect(assertNodeManifestTurbopackTemplateConsumer(input)).resolves.toMatchObject({
      kind: 'pages',
    });
  });

  it('refuses a literal selector without the same selected export binding', async () => {
    const own = await fixture('RouteKind', '', 'other');

    await expect(assertNodeManifestTurbopackTemplateConsumer(own.input)).rejects.toThrow(
      'unrecognized external import',
    );
  });

  it.each(['RouteKind', 'hoist'] as const)(
    'closes the full raw Pages graph for embedded %s without compiler privilege',
    async (role) => {
      const own = await manifestTemplateProofFixture(directory, 'pages');
      const suffix = role === 'RouteKind' ? '/server/route-kind.js' : '/build/templates/helpers.js';
      const imports = own.imports.get(own.chunk);
      const known = imports?.find((edge) => edge.target.endsWith(suffix));
      assert(known !== undefined && imports !== undefined);
      const compact = role === 'RouteKind' ? 'k' : 'f';
      const namespace = role === 'RouteKind' ? '_routekind' : '_helpers';
      const raw = await readFile(own.chunk, 'utf8');
      const external = `runtimeContext.x(${jsLiteral(known.specifier)},()=>require(${jsLiteral(known.specifier)}))`;
      let code = raw
        .replace(external, () => 'runtimeContext.i(2)')
        .replaceAll(`${namespace}.${role}`, () => `${namespace}.${compact}`);
      assert(code !== raw);
      code = `${code.slice(0, -2)},2,(ctx)=>{"use strict";${await helperSource(role)};ctx.s([${jsLiteral(compact)},()=>${role}]);}];`;
      await writeFile(own.chunk, code);
      const source = manifestTemplateSource(code);
      own.sources.set(own.chunk, { file: own.chunk, sha256: source.sha256 });
      own.imports.set(
        own.chunk,
        imports.filter((edge) => edge !== known),
      );
      own.graph.importers.clear();
      for (const id of own.sources.keys()) own.graph.importers.set(id, []);
      for (const [from, edges] of own.imports)
        for (const edge of edges) own.graph.importers.get(edge.target)?.push(from);
      const proof = await proveNodeManifests(own.input, own.graph);

      expect(proof.codeSources).toContainEqual({ file: own.chunk, sha256: source.sha256 });
      expect(proof.approvedCompilerSources).toStrictEqual([own.sources.get(own.runtime)]);
    },
  );

  it('refuses forged, copied and cross-owner helper authority', async () => {
    const own = await fixture();
    own.descriptor.helper = { ...own.descriptor.helper };

    await expect(assertNodeManifestTurbopackTemplateConsumer(own.input)).rejects.toThrow(
      'changed template helper import',
    );

    const fresh = await fixture();

    await expect(
      assertNodeManifestTurbopackTemplateConsumer({
        ...fresh.input,
        helperOwner: { identity: Symbol('different owner') },
      }),
    ).rejects.toThrow('changed template helper import');
  });

  it('refuses descriptor and actual dependency tampering', async () => {
    const own = await fixture();
    own.descriptor.sha256 = '0'.repeat(64);

    await expect(assertNodeManifestTurbopackTemplateConsumer(own.input)).rejects.toThrow(
      'changed template helper import',
    );

    const fresh = await fixture();
    fresh.target.imports.push({ specifier: 'extra', target: 'unknown' });

    await expect(assertNodeManifestTurbopackTemplateConsumer(fresh.input)).rejects.toThrow(
      'changed template helper import',
    );
  });

  it('refuses same-content original source replacement after minting', async () => {
    const own = await fixture();
    own.physical.source = { ...own.physical.source };

    await expect(assertNodeManifestTurbopackTemplateConsumer(own.input)).rejects.toThrow(
      'changed template helper import',
    );
  });

  it('refuses a copied owner and same-content consumer projection', async () => {
    const own = await fixture();

    await expect(
      assertNodeManifestTurbopackTemplateConsumer({ ...own.input, helperOwner: { ...own.owner } }),
    ).rejects.toThrow('changed template helper import');
    await expect(
      assertNodeManifestTurbopackTemplateConsumer({
        ...own.input,
        projection: { ...own.input.projection },
      }),
    ).rejects.toThrow('changed template helper import');
  });

  it('does not let a stale helper proof fall back to forged Next file metadata', async () => {
    const own = await fixture('RouteKind', '', 'RouteKind');
    own.descriptor.file = own.known.file;
    own.descriptor.sha256 = own.known.sha256;

    await expect(assertNodeManifestTurbopackTemplateConsumer(own.input)).rejects.toThrow(
      'changed template helper import',
    );
  });

  it('refuses mismatched runtime and actual dependency edge at mint time', async () => {
    const own = await fixture();
    own.target.runtimeId = 'other-runtime';

    expect(certifyNodeManifestTemplateHelperImport(own.proofInput)).toBeUndefined();

    own.target.runtimeId = 'runtime';
    own.consumer.imports = own.consumer.imports.map((edge) => ({ ...edge, target: 'wrong' }));

    expect(certifyNodeManifestTemplateHelperImport(own.proofInput)).toBeUndefined();
  });

  it.each(['RouteKind.PAGES="other";', 'const escaped=RouteKind;'])(
    'refuses mutation or escape in the actual helper source: %s',
    async (extra) => {
      const own = await fixture('RouteKind', extra);

      await expect(assertNodeManifestTurbopackTemplateConsumer(own.input)).rejects.toThrow(
        'unrecognized external import',
      );
    },
  );
});
