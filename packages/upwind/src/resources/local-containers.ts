import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ContainerDefinition } from '@stayingupwind/core/bundle';
import type { MiniflareOptions } from 'miniflare';

import type { LocalDurableObject } from './local-objects.ts';
import { watchFile } from './watch-sources.ts';

const BUILD_TIMEOUT_MS = 900_000;
const MAX_ERROR_BYTES = 16_384;
const LOCAL_TAG_LENGTH = 24;
const PLATFORM_FLAG = '--platform';
const PLATFORM = 'linux/amd64';
// Same pinned proxy as this Miniflare release, using its canonical digest rather than tag@digest.
const EGRESS_IMAGE =
  'docker.io/cloudflare/proxy-everything@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8';

function proxyImage(): string {
  return process.env['MINIFLARE_CONTAINER_EGRESS_IMAGE'] ?? EGRESS_IMAGE;
}

type DockerCommand = (args: readonly string[], signal?: AbortSignal) => Promise<void>;

async function docker(args: readonly string[], signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', [...args], {
      timeout: BUILD_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(signal !== undefined && { signal }),
    });
    let tail = Buffer.alloc(0);
    const retain = (chunk: Buffer): void => {
      tail = Buffer.concat([tail, chunk]).subarray(-MAX_ERROR_BYTES);
    };
    child.stdout.on('data', retain);
    child.stderr.on('data', retain);
    child.once('error', reject);
    child.once('close', (code, termination) => {
      if (code === 0) resolve();
      else reject(new Error(`Docker failed (${termination ?? code}): ${tail.toString('utf8')}`));
    });
  });
}

/** Resolve symlinks before Docker sees a path; no source may leave the project. */
async function sourcePath(projectDir: string, source: string, directory: boolean): Promise<string> {
  const root = await realpath(projectDir);
  const resolved = await realpath(path.resolve(root, source));
  const relative = path.relative(root, resolved);
  const details = await stat(resolved);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    (directory ? !details.isDirectory() : !details.isFile())
  )
    throw new Error('Container Dockerfile and build context must be inside the project');
  return resolved;
}

async function prepareImage(input: {
  readonly projectDir: string;
  readonly name: string;
  readonly definition: ContainerDefinition;
  readonly run: DockerCommand;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const { projectDir, name, definition, run, signal } = input;
  const root = await realpath(projectDir);
  const digest = createHash('sha256').update(`${root}\0${name}`).digest('hex');
  const imageName = `upwind-local-${digest.slice(0, LOCAL_TAG_LENGTH)}:latest`;
  const { image } = definition;
  if ('dockerfile' in image) {
    const file = await sourcePath(projectDir, image.dockerfile, false);
    const context = await sourcePath(
      projectDir,
      image.buildContext ?? path.dirname(image.dockerfile),
      true,
    );
    await run(
      ['build', PLATFORM_FLAG, PLATFORM, '--file', file, '--tag', imageName, context],
      signal,
    );
  } else {
    await run(['pull', PLATFORM_FLAG, PLATFORM, image.reference], signal);
    await run(['tag', image.reference, imageName], signal);
  }
  return imageName;
}

function proxyPreparation(run: DockerCommand, signal?: AbortSignal): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= run(['pull', PLATFORM_FLAG, PLATFORM, proxyImage()], signal);
    return pending;
  };
}

interface PrepareOptions {
  readonly signal?: AbortSignal;
  /** The same argument-array boundary in tests, without a Docker daemon. */
  readonly run?: DockerCommand;
}

/** A failed image removes only its owner; ordinary objects and storage remain available. */
export async function prepareLocalContainers(
  projectDir: string,
  objects: readonly LocalDurableObject[],
  watch: { readonly files: Set<string>; readonly versions: Map<string, string> },
  options: PrepareOptions = {},
): Promise<readonly LocalDurableObject[]> {
  const prepared: LocalDurableObject[] = [];
  const prepareProxy = proxyPreparation(options.run ?? docker, options.signal);
  for (const object of objects) {
    options.signal?.throwIfAborted();
    const { container } = object.declaration;
    if (container === undefined) {
      prepared.push(object);
      continue;
    }
    if ('dockerfile' in container.image) {
      const { dockerfile, buildContext } = container.image;
      const context = buildContext ?? path.dirname(dockerfile);
      for (const source of [
        dockerfile,
        `${dockerfile}.dockerignore`,
        path.join(context, '.dockerignore'),
      ])
        watchFile(path.resolve(projectDir, source), watch.files, watch.versions);
    }
    try {
      const run = options.run ?? docker;
      const containerImageName = await prepareImage({
        projectDir,
        name: object.declaration.name,
        definition: container,
        run,
        ...(options.signal !== undefined && { signal: options.signal }),
      });
      await prepareProxy();
      prepared.push({ ...object, containerImageName });
    } catch (error) {
      options.signal?.throwIfAborted();
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `upwind: could not prepare Container ${object.declaration.name}; its namespace is unavailable, and other local resources remain available. Ensure Docker is running.\n${reason}`,
      );
    }
  }
  return prepared;
}

/** The image CLI and runtime must address the same explicitly selected Docker engine. */
export function containerEngine(
  objects: readonly LocalDurableObject[],
): Pick<MiniflareOptions, 'containerEngine'> {
  if (objects.every((object) => object.containerImageName === undefined)) return {};
  const fallback =
    process.platform === 'win32' ? '//./pipe/docker_engine' : 'unix:///var/run/docker.sock';
  return {
    containerEngine: {
      localDocker: {
        socketPath: process.env['DOCKER_HOST'] ?? fallback,
        containerEgressInterceptorImage: proxyImage(),
      },
    },
  };
}
