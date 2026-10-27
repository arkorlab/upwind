import { readFile } from 'node:fs/promises';
/* eslint-disable n/no-process-exit, unicorn/no-process-exit -- emitted executable owns its process and shutdown deadline */
import { createServer } from 'node:http';
import path from 'node:path';

import {
  type DeploymentBundle,
  type PackedPrerenders,
  type Prerender,
  unpackPrerenders,
} from '@stayingupwind/core/bundle';
import { TaskGroup } from '@stayingupwind/runtime/native';
import entry, { closeNodeBridge, configureImageCache } from 'arkor:native-function';

// Private host sources are embedded into the published executable, never imported by its user.
import { createNativeCache } from '../../../cache/src/native/index.ts';
import {
  cacheEntryIdsOf,
  seedEntriesOf,
  seededGenerationAt,
} from '../../../deploy/src/cache-seed.ts';
import { drainNativeWork } from './drain.ts';
import { nativeOrigin, nativeRequest, writeNativeResponse } from './http.ts';
import { listeningOn } from './listening.ts';

const SHUTDOWN_MS = 30_000;
const DEFAULT_PORT = 3000;
const MAX_PORT = 65_535;
const HTTP_BAD_REQUEST = 400;
const HTTP_INTERNAL_ERROR = 500;
const ROOT = import.meta.dirname;

interface NativeManifest {
  readonly format: 'upwind-node';
  readonly v: 1;
  readonly projectDir: string;
  readonly distDir: string;
  readonly deploymentId: string;
  readonly buildId: string;
  readonly nextVersion: string;
  readonly generatedAt: string;
  readonly imageCacheBytes?: number;
}

function manifestOf(value: unknown): NativeManifest {
  if (typeof value !== 'object' || value === null) throw new Error('invalid native manifest');
  const fields = value as Record<string, unknown>;
  if (fields['format'] !== 'upwind-node' || fields['v'] !== 1)
    throw new Error('unsupported native artifact format');
  for (const field of [
    'projectDir',
    'distDir',
    'deploymentId',
    'buildId',
    'nextVersion',
    'generatedAt',
  ]) {
    if (typeof fields[field] !== 'string' || fields[field] === '')
      throw new Error(`invalid native manifest ${field}`);
  }
  if (!/^[\w~-]+$/u.test(String(fields['deploymentId'])))
    throw new Error('invalid native deployment identity');
  const imageCacheBytes = fields['imageCacheBytes'];
  if (
    imageCacheBytes !== undefined &&
    (typeof imageCacheBytes !== 'number' ||
      !Number.isSafeInteger(imageCacheBytes) ||
      imageCacheBytes < 0)
  )
    throw new Error('invalid native manifest imageCacheBytes');
  for (const field of ['projectDir', 'distDir']) {
    const relative = String(fields[field]);
    const absolute = path.resolve(ROOT, relative);
    if (path.isAbsolute(relative) || !absolute.startsWith(`${ROOT}${path.sep}`))
      throw new Error('native artifact path escapes its root');
  }
  return value as NativeManifest;
}

function portOf(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = /^\d+$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(port) || port < 0 || port > MAX_PORT)
    throw new Error('PORT must be a whole number from 0 to 65535');
  return port;
}

function report(error: unknown): void {
  console.error('upwind: native request failed', error);
}

async function main(): Promise<void> {
  const manifestText = await readFile(path.join(ROOT, 'manifest.json'), 'utf8');
  const manifest = manifestOf(JSON.parse(manifestText));
  const raw = JSON.parse(await readFile(path.join(ROOT, 'runtime.json'), 'utf8')) as Omit<
    DeploymentBundle,
    'prerenders'
  > & { readonly prerenders: PackedPrerenders };
  const bundle = {
    ...raw,
    generatedAt: manifest.generatedAt,
    prerenders: unpackPrerenders<Prerender>(raw.prerenders),
  };
  const scopeId = manifest.deploymentId;
  // Resolve the writable directory before adopting the copied project's working directory.
  const defaultCache = path.resolve('.upwind/node-cache');
  const outsideArtifact = defaultCache.startsWith(`${ROOT}${path.sep}`)
    ? path.resolve(ROOT, '../.upwind/node-cache')
    : defaultCache;
  const cacheRoot = path.resolve(process.env['UPWIND_NODE_CACHE_DIR'] ?? outsideArtifact);
  // The images it makes, beside the deployments' caches: one directory every deployment the root
  // serves shares, as an image of a URL of the internet is the same for each, and an image of a path
  // of the application is kept under the deployment that answered it (`image-cache.ts`).
  configureImageCache({
    directory: path.join(cacheRoot, 'images'),
    maxBytes: manifest.imageCacheBytes,
  });
  const originValue = process.env['UPWIND_NODE_ORIGIN'];
  const origin = originValue === undefined ? undefined : nativeOrigin(originValue);
  const hostname = process.env['UPWIND_NODE_HOSTNAME'] ?? '0.0.0.0';
  const port = portOf(process.env['PORT']);
  const seeds = await seedEntriesOf(bundle, cacheEntryIdsOf(bundle), {
    scopeId,
    generatedAt: seededGenerationAt(bundle, Date.now()),
  });
  const cache = await createNativeCache({
    directory: path.join(cacheRoot, scopeId),
    scopeId,
    buildId: manifest.buildId,
    deploymentId: manifest.deploymentId,
    // eslint-disable-next-line unicorn/no-missing-local-resource -- emitted beside this executable
    workerUrl: new URL('cache-worker.mjs', import.meta.url),
    seed: { entries: seeds, blobsDirectory: path.join(ROOT, 'blobs') },
  });
  Reflect.set(process.env, 'NODE_ENV', 'production');
  process.env['NEXT_RUNTIME'] = 'nodejs';
  process.env['NEXT_DEPLOYMENT_ID'] = manifest.deploymentId;
  process.chdir(path.resolve(ROOT, manifest.projectDir));
  const tasks = new TaskGroup(report);
  const requests = new TaskGroup(report);
  const env = { UPWIND_NODE_CACHE: cache.binding };
  const server = createServer((req, res) => {
    let request: Request;
    try {
      request = nativeRequest(req, res, origin);
    } catch {
      res.writeHead(HTTP_BAD_REQUEST, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'private, no-store',
      });
      res.end('Bad Request');
      return;
    }
    const answered = async (): Promise<void> => {
      try {
        await writeNativeResponse(
          req,
          res,
          await entry.fetch(request, env, { waitUntil: tasks.waitUntil }),
        );
      } catch (error) {
        if (request.signal.aborted) return;
        report(error);
        if (res.headersSent) {
          res.destroy(error instanceof Error ? error : new Error('native response failed'));
        } else {
          res.writeHead(HTTP_INTERNAL_ERROR, {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'private, no-store',
          });
          res.end('Internal Server Error');
        }
      }
    };
    requests.waitUntil(answered());
  });
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    const deadline = Date.now() + SHUTDOWN_MS;
    const remaining = (): number => Math.max(0, deadline - Date.now());
    const forced = setTimeout(() => {
      server.closeAllConnections();
      // Accepted JavaScript cannot be forcibly cancelled safely inside the same process.
      process.exit(1);
    }, SHUTDOWN_MS);
    const drain = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      const drained = await drainNativeWork({
        requests,
        tasks,
        closeBridge: closeNodeBridge,
        remaining,
      });
      await cache.close();
      clearTimeout(forced);
      process.exit(drained ? 0 : 1);
    };
    void drain().catch((error: unknown) => {
      report(error);
      process.exit(1);
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let listening: string | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, hostname, () => {
        server.off('error', reject);
        // Before any request is taken: the first render may already read the port.
        const address = server.address();
        if (address !== null && typeof address !== 'string')
          listening = listeningOn(address, process.env);
        resolve();
      });
    });
  } catch (error) {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await closeNodeBridge(0);
    await cache.close();
    throw error;
  }
  if (listening !== undefined) console.log(`upwind: native server listening on ${listening}`);
}

try {
  await main();
} catch (error) {
  report(error);
  process.exit(1);
}
