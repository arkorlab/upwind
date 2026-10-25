import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContainerDefinition } from '../../core/src/bundle/containers.ts';
import { prepareLocalContainers } from '../src/resources/local-containers.ts';
import type { LocalDurableObject } from '../src/resources/local-objects.ts';

const IMAGE: ContainerDefinition = {
  image: { reference: 'alpine:3.22' },
  instanceType: 'lite',
  maxInstances: 3,
};

function object(name: string, container?: ContainerDefinition): LocalDurableObject {
  return {
    declaration: {
      name,
      module: 'object.ts',
      // eslint-disable-next-line unicorn/no-keyword-prefix -- The public registration field.
      className: 'Object',
      ...(container !== undefined && { container }),
    },
    source: 'export default {};',
    inputs: [],
  };
}

describe('local Container image preparation', () => {
  let directory: string;
  let project: string;
  let files: Set<string>;
  let versions: Map<string, string>;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'upwind-containers-'));
    project = path.join(directory, 'project');
    await mkdir(project);
    files = new Set();
    versions = new Map();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('pulls existing images for amd64 and uses a local tag without invoking an instance', async () => {
    const run = vi.fn<(args: readonly string[]) => Promise<void>>().mockResolvedValue(undefined);
    const normal = object('NORMAL');
    const prepared = await prepareLocalContainers(
      project,
      [normal, object('JOBS', IMAGE)],
      { files, versions },
      { run },
    );
    const tag = prepared[1]?.containerImageName;

    expect(tag).toMatch(/^upwind-local-[a-f\d]{24}:latest$/u);
    expect(prepared[0]).toBe(normal);
    expect(run.mock.calls).toStrictEqual([
      [['pull', '--platform', 'linux/amd64', 'alpine:3.22'], undefined],
      [['tag', 'alpine:3.22', tag], undefined],
      [
        [
          'pull',
          '--platform',
          'linux/amd64',
          expect.stringContaining('cloudflare/proxy-everything@sha256:'),
        ],
        undefined,
      ],
    ]);
  });

  it('builds with an explicit project-contained context and watches image configuration', async () => {
    const container: ContainerDefinition = {
      ...IMAGE,
      image: { dockerfile: 'Dockerfile', buildContext: '.' },
    };
    await writeFile(path.join(project, 'Dockerfile'), 'FROM scratch');
    const run = vi.fn<(args: readonly string[]) => Promise<void>>().mockResolvedValue(undefined);
    const [prepared] = await prepareLocalContainers(
      project,
      [object('JOBS', container)],
      { files, versions },
      { run },
    );
    const root = await realpath(project);

    expect(run.mock.calls).toStrictEqual([
      [
        [
          'build',
          '--platform',
          'linux/amd64',
          '--file',
          path.join(root, 'Dockerfile'),
          '--tag',
          prepared?.containerImageName,
          root,
        ],
        undefined,
      ],
      [
        [
          'pull',
          '--platform',
          'linux/amd64',
          expect.stringContaining('cloudflare/proxy-everything@sha256:'),
        ],
        undefined,
      ],
    ]);
    expect(files.has(path.join(project, 'Dockerfile'))).toBe(true);
    expect(files.has(path.join(project, '.dockerignore'))).toBe(true);
    expect(files.has(path.join(project, 'Dockerfile.dockerignore'))).toBe(true);
  });

  it('keeps unrelated namespaces when Docker fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      /* Expected isolated failure. */
    });
    const run = vi
      .fn<(args: readonly string[]) => Promise<void>>()
      .mockRejectedValue(new Error('Docker unavailable'));
    const normal = object('NORMAL');
    const prepared = await prepareLocalContainers(
      project,
      [object('JOBS', IMAGE), normal],
      { files, versions },
      { run },
    );

    expect(prepared).toStrictEqual([normal]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Container JOBS'));
  });

  it('refuses a Dockerfile symlink outside the project before running Docker', async () => {
    await writeFile(path.join(directory, 'external'), 'FROM scratch');
    await symlink(path.join(directory, 'external'), path.join(project, 'Dockerfile'));
    vi.spyOn(console, 'warn').mockImplementation(() => {
      /* Expected invalid source. */
    });
    const run = vi.fn<(args: readonly string[]) => Promise<void>>().mockResolvedValue(undefined);
    const prepared = await prepareLocalContainers(
      project,
      [object('JOBS', { ...IMAGE, image: { dockerfile: 'Dockerfile' } })],
      { files, versions },
      { run },
    );

    expect(prepared).toStrictEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('propagates cancellation instead of publishing a partially prepared namespace', async () => {
    const controller = new AbortController();
    const run = vi.fn<(args: readonly string[]) => Promise<void>>().mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Error('cancelled'));
    });

    await expect(
      prepareLocalContainers(
        project,
        [object('JOBS', IMAGE)],
        { files, versions },
        { run, signal: controller.signal },
      ),
    ).rejects.toThrow('This operation was aborted');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
