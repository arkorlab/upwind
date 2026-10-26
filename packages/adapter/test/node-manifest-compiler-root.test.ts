import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest';

import {
  assertCurrentNodeManifestCompilerRoot,
  certifyNodeManifestCompilerRoot,
  nodeManifestCompilerRoot,
  type NodeManifestCompilerRootInput,
} from '../src/node-manifest-compiler-root.ts';

describe('persisted compiler root path basis', () => {
  let area: string;
  let repo: string;
  let project: string;
  let dist: string;
  let file: string;
  let input: { distDir: string; projectDir: string };

  beforeEach(async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'upwind-compiler-root-'));
    area = await realpath(temporary);
    repo = path.join(area, 'repo');
    project = path.join(repo, 'apps', 'site');
    dist = path.join(project, '.next');
    file = path.join(dist, 'required-server-files.json');
    await mkdir(dist, { recursive: true });
    input = { distDir: dist, projectDir: project };
  });

  afterEach(async () => {
    await rm(area, { recursive: true, force: true });
  });

  function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const config: Record<string, unknown> = {
      distDir: '.next',
      experimental: { isExperimentalCompile: false },
      ...overrides,
    };
    const tracing = config['outputFileTracingRoot'];
    const basis = typeof tracing === 'string' && tracing.length > 0 ? tracing : project;
    const buildDist = typeof config['distDir'] === 'string' ? config['distDir'] : '.next';
    return {
      version: 1,
      config,
      appDir: project,
      relativeAppDir: path.relative(basis, project),
      files: [path.join(buildDist, 'BUILD_ID'), path.join(buildDist, 'required-server-files.json')],
      ignore: [],
    };
  }
  async function stored(value: unknown = manifest()): Promise<void> {
    await writeFile(file, JSON.stringify(value));
  }
  async function certified(actual: NodeManifestCompilerRootInput = input) {
    const proof = await certifyNodeManifestCompilerRoot(actual);
    assert.isDefined(proof);
    return proof;
  }

  it.each(['turbopack.root', 'outputFileTracingRoot', 'appDir'] as const)(
    'uses the exact primary compiler precedence for %s',
    async (basis) => {
      const choices = {
        'turbopack.root': { turbopack: { root: repo }, outputFileTracingRoot: area },
        outputFileTracingRoot: { outputFileTracingRoot: repo },
        appDir: {},
      };
      const config = choices[basis];
      await stored(manifest(config));
      const proof = await certified();
      const data = nodeManifestCompilerRoot(proof, input);

      expect(data.basis).toBe(basis);
      expect(data.compilerRoot).toBe(basis === 'appDir' ? project : repo);
      expect(data.canonicalCompilerRoot).toBe(data.compilerRoot);
      await expect(assertCurrentNodeManifestCompilerRoot(proof, input)).resolves.toBeUndefined();
    },
  );

  it('preserves empty-string fallback without coercing malformed root types', async () => {
    await stored(manifest({ turbopack: { root: '' }, outputFileTracingRoot: repo }));
    const traced = nodeManifestCompilerRoot(await certified(), input);
    await stored(manifest({ turbopack: { root: '' }, outputFileTracingRoot: '' }));
    const local = nodeManifestCompilerRoot(await certified(), input);

    expect(traced.basis).toBe('outputFileTracingRoot');
    expect(local.basis).toBe('appDir');
  });

  it('seals frozen declared/canonical DATA and exact metadata bytes without granting any role', async () => {
    await stored();
    const bytes = await readFile(file);
    const data = nodeManifestCompilerRoot(await certified(), input);

    expect(data.metadata).toStrictEqual({
      file,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(data.projectDir).toBe(project);
    expect(data.canonicalDistDir).toBe(dist);
    expect(Object.isFrozen(data)).toBe(true);
    expect(Object.isFrozen(data.metadata)).toBe(true);
    expect(data).not.toHaveProperty('requiresReviewedRuntime');
    expect(data).not.toHaveProperty('helper');
  });

  it('returns no evidence for absent metadata or an absent build directory', async () => {
    await expect(certifyNodeManifestCompilerRoot(input)).resolves.toBeUndefined();

    await rm(dist, { recursive: true });

    await expect(certifyNodeManifestCompilerRoot(input)).resolves.toBeUndefined();
  });

  it.each([
    ['other schema', { version: 2 }, 'build metadata'],
    ['not a build object', [], 'metadata object'],
    ['no build file inventory', { version: 1, config: {} }, 'build metadata'],
  ])('rejects %s', async (_name, value, reason) => {
    await stored(value);

    await expect(certifyNodeManifestCompilerRoot(input)).rejects.toThrow(reason);
  });

  it.each([
    ['relative turbo root', { turbopack: { root: '../repo' } }],
    ['numeric turbo root', { turbopack: { root: 1 } }],
    ['null turbo root', { turbopack: { root: null } }],
    ['null turbo config', { turbopack: null }],
    ['relative tracing root', { outputFileTracingRoot: '..' }],
    ['boolean tracing root', { outputFileTracingRoot: false }],
  ])('rejects %s rather than guessing a fallback', async (_name, config) => {
    await stored(manifest(config));

    await expect(certifyNodeManifestCompilerRoot(input)).rejects.toThrow(/config/u);
  });

  it('rejects filtered runtime config even if it still contains apparent root fields', async () => {
    await stored(
      manifest({
        turbopack: { root: repo },
        experimental: { isExperimentalCompile: false, runtimeServerDeploymentId: true },
      }),
    );

    await expect(certifyNodeManifestCompilerRoot(input)).rejects.toThrow('filtered config');
  });

  it('requires the persisted real appDir to match the actual current project', async () => {
    const other = path.join(area, 'another-app');
    await mkdir(other);
    await stored({ ...manifest(), appDir: other });

    await expect(certifyNodeManifestCompilerRoot(input)).rejects.toThrow('appDir');
  });

  it('rejects conflicting relativeAppDir and missing self/BUILD_ID build records', async () => {
    await stored({ ...manifest({ outputFileTracingRoot: repo }), relativeAppDir: 'other' });

    await expect(certifyNodeManifestCompilerRoot(input)).rejects.toThrow(
      'build directory evidence',
    );

    await stored({ ...manifest(), files: ['.next/BUILD_ID'] });

    await expect(certifyNodeManifestCompilerRoot(input)).rejects.toThrow(
      'build directory evidence',
    );

    await stored({ ...manifest(), files: ['.next/required-server-files.json'] });

    await expect(certifyNodeManifestCompilerRoot(input)).rejects.toThrow(
      'build directory evidence',
    );
  });

  it('binds config.distDir to this exact output rather than another existing build directory', async () => {
    await mkdir(path.join(project, 'other-output'));
    await stored(manifest({ distDir: 'other-output' }));

    await expect(certifyNodeManifestCompilerRoot(input)).rejects.toThrow(
      'output directory mismatch',
    );
  });

  it('supports a declared external dist directory only when the producer config binds it', async () => {
    const external = path.join(repo, 'build-output');
    await mkdir(external);
    input.distDir = external;
    file = path.join(external, 'required-server-files.json');
    await stored(
      manifest({ distDir: path.relative(project, external), outputFileTracingRoot: repo }),
    );
    const data = nodeManifestCompilerRoot(await certified(), input);

    expect(data.distDir).toBe(external);
    expect(data.canonicalDistDir).toBe(external);
    expect(data.compilerRoot).toBe(repo);
  });

  it('rejects a configured compiler root whose canonical directory does not own the project', async () => {
    const outside = path.join(area, 'outside');
    await mkdir(outside);
    await stored(manifest({ turbopack: { root: outside } }));

    await expect(certifyNodeManifestCompilerRoot(input)).rejects.toThrow('outside project scope');
  });

  it('retains a configured symlink root spelling separately from its canonical identity', async () => {
    const alias = path.join(area, 'repo-alias');
    await symlink(repo, alias);
    await stored(manifest({ turbopack: { root: alias } }));
    const proof = await certified();
    const data = nodeManifestCompilerRoot(proof, input);

    expect(data.compilerRoot).toBe(alias);
    expect(data.canonicalCompilerRoot).toBe(repo);
    await expect(assertCurrentNodeManifestCompilerRoot(proof, input)).resolves.toBeUndefined();
  });

  it('records a project alias without replacing the emitted canonical appDir', async () => {
    const alias = path.join(area, 'project-alias');
    await symlink(project, alias);
    input.projectDir = alias;
    await stored();
    const data = nodeManifestCompilerRoot(await certified(), input);

    expect(data.projectDir).toBe(alias);
    expect(data.appDir).toBe(project);
    expect(data.compilerRoot).toBe(project);
  });

  it('allows a declared dist alias but never a symlink metadata leaf', async () => {
    const alias = path.join(area, 'dist-alias');
    await symlink(dist, alias);
    input.distDir = alias;
    await stored();
    const data = nodeManifestCompilerRoot(await certified(), input);
    const outside = path.join(area, 'foreign.json');
    await rename(file, outside);
    await symlink(outside, file);

    expect(data.distDir).toBe(alias);
    expect(data.metadata.file).toBe(file);
    await expect(certifyNodeManifestCompilerRoot(input)).rejects.toThrow(
      'regular bounded metadata',
    );
  });

  it('rejects malformed, duplicate and oversized metadata without exposing its contents', async () => {
    await writeFile(file, '{invalid');

    await expect(certifyNodeManifestCompilerRoot(input)).rejects.toThrow('metadata JSON');

    await writeFile(
      file,
      JSON.stringify(manifest()).replace('"version":1', '"version":1,"version":1'),
    );

    await expect(certifyNodeManifestCompilerRoot(input)).rejects.toThrow(
      'duplicate metadata fields',
    );

    await writeFile(file, Buffer.alloc(4_194_305));

    await expect(certifyNodeManifestCompilerRoot(input)).rejects.toThrow(
      'regular bounded metadata',
    );
  });

  it('rejects invalid UTF-8 and directory metadata leaves', async () => {
    await writeFile(file, Buffer.from([255]));

    await expect(certifyNodeManifestCompilerRoot(input)).rejects.toThrow('metadata encoding');

    await rm(file);
    await mkdir(file);

    await expect(certifyNodeManifestCompilerRoot(input)).rejects.toThrow(
      'regular bounded metadata',
    );
  });

  it('rejects copied proofs and identical replacement argument objects', async () => {
    await stored();
    const proof = await certified();

    expect(() => nodeManifestCompilerRoot({ ...proof }, input)).toThrow('foreign or copied proof');
    expect(() => nodeManifestCompilerRoot(proof, { ...input })).toThrow('foreign or copied proof');
    await expect(assertCurrentNodeManifestCompilerRoot({ ...proof }, input)).rejects.toThrow(
      'foreign or copied proof',
    );
  });

  it('rejects metadata byte changes and same-byte inode replacement on async revalidation', async () => {
    await stored();
    const proof = await certified();
    const bytes = await readFile(file);
    const replacement = path.join(dist, 'replacement.json');
    await writeFile(replacement, bytes);
    await rename(replacement, file);

    await expect(assertCurrentNodeManifestCompilerRoot(proof, input)).rejects.toThrow(
      'stale metadata',
    );

    const replaced = await certified();
    await writeFile(file, Buffer.concat([bytes, Buffer.from('\n')]));

    await expect(assertCurrentNodeManifestCompilerRoot(replaced, input)).rejects.toThrow(
      'stale metadata',
    );
  });

  it('rejects a root symlink retarget even when original metadata bytes stay unchanged', async () => {
    const alias = path.join(area, 'root-alias');
    await symlink(repo, alias);
    await stored(manifest({ turbopack: { root: alias } }));
    const proof = await certified();
    await unlink(alias);
    await symlink(area, alias);

    await expect(assertCurrentNodeManifestCompilerRoot(proof, input)).rejects.toThrow(
      'stale metadata or root identity',
    );
  });

  it('rejects argument retargeting while certification is awaiting filesystem evidence', async () => {
    await stored();
    const pending = certifyNodeManifestCompilerRoot(input);
    input.projectDir = repo;

    await expect(pending).rejects.toThrow('changed input paths');

    input.projectDir = project;

    await expect(certified()).resolves.toBeDefined();
  });

  it('rejects argument retargeting during async freshness checks', async () => {
    await stored();
    const proof = await certified();
    const pending = assertCurrentNodeManifestCompilerRoot(proof, input);
    input.distDir = repo;

    await expect(pending).rejects.toThrow('changed input paths');

    input.distDir = dist;

    expect(nodeManifestCompilerRoot(proof, input).distDir).toBe(dist);
  });

  it('refuses relative paths and accessor-backed input assertions', async () => {
    await expect(certifyNodeManifestCompilerRoot({ ...input, projectDir: '.' })).rejects.toThrow(
      'absolute input paths',
    );
    await expect(
      certifyNodeManifestCompilerRoot({
        distDir: dist,
        get projectDir() {
          return project;
        },
      }),
    ).rejects.toThrow('absolute input paths');
  });
});
