import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { BlobRef, DeploymentBundle } from '@stayingupwind/core/bundle';
import type { DeployTarget } from '@stayingupwind/deploy/deploy';
import type {
  RetireScopeInput,
  RetireScopeResult,
  SeedEntriesInput,
  SeedEntriesResult,
  SeedScopeInput,
  SeedScopeResult,
} from '@stayingupwind/host/cache';
import { blobObjectKey } from '@stayingupwind/host/storage';

import type { AgentClient } from './agent-client.ts';
import { AGENT_PATHS, METADATA_HEADER, MISSING_BATCH } from './workers/protocol.ts';

/**
 * Where a deploy stages and publishes a build (`DeployTarget`): its blobs from the directory it was
 * built in, and the account's stores and cache authority through the deploy agent.
 *
 * The blobs go up first, and only those the bucket does not hold yet (`uploadBuildBlobs`): asked
 * for a thousand at a time and sent several at once, rather than one after another as staging would
 * copy them. A deployment of a build much like the last one sends little.
 */

/** How many blobs go up at once. */
const UPLOAD_CONCURRENCY = 8;

function kv(key: string): string {
  return `${AGENT_PATHS.kv}${encodeURIComponent(key)}`;
}

function blob(key: string): string {
  return `${AGENT_PATHS.blob}${encodeURIComponent(key)}`;
}

/** What a write carries, in an array of its own: a `fetch` body is never a view of shared memory. */
function bodyOf(value: Uint8Array | string): string | Uint8Array<ArrayBuffer> {
  return typeof value === 'string' ? value : new Uint8Array(value);
}

function metadataHeader(metadata: unknown): Record<string, string> {
  return metadata === undefined
    ? {}
    : { [METADATA_HEADER]: encodeURIComponent(JSON.stringify(metadata)) };
}

async function bytesOf(response: Response | undefined): Promise<Uint8Array | undefined> {
  return response === undefined ? undefined : new Uint8Array(await response.arrayBuffer());
}

/** The build's blob of that digest, from the directory it was built in. */
async function localBlob(bundleDir: string, sha256: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path.join(bundleDir, 'blobs', sha256)));
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/** Every blob staging reads from the bucket: each prerender's body and postponed state, and each file. */
function stagedBlobs(bundle: DeploymentBundle): BlobRef[] {
  const refs = new Map<string, BlobRef>();
  const add = (ref: BlobRef | undefined): void => {
    if (ref !== undefined && !refs.has(ref.sha256)) {
      refs.set(ref.sha256, ref);
    }
  };
  for (const prerender of bundle.prerenders) {
    add(prerender.body);
    add(prerender.postponed);
  }
  for (const file of bundle.staticFiles) {
    add(file.blob);
  }
  return [...refs.values()];
}

/** The keys of an answer to `missing`, each one of those asked about; nothing for any other answer. */
function absentOf(answer: unknown, asked: ReadonlySet<string>): readonly string[] | undefined {
  const absent: unknown =
    typeof answer === 'object' && answer !== null ? Reflect.get(answer, 'missing') : undefined;
  if (!Array.isArray(absent)) {
    return undefined;
  }
  const keys: string[] = [];
  for (const key of absent) {
    if (typeof key !== 'string' || !asked.has(key)) {
      return undefined;
    }
    keys.push(key);
  }
  return keys;
}

/**
 * Of these keys, the ones the bucket does not hold. An agent that answers anything but the list
 * stops the deploy here: taking it for "all held" would send nothing, and fail at publication over
 * a blob that was never sent.
 */
async function missingOf(agent: AgentClient, keys: readonly string[]): Promise<Set<string>> {
  const missing = new Set<string>();
  for (let start = 0; start < keys.length; start += MISSING_BATCH) {
    const batch = keys.slice(start, start + MISSING_BATCH);
    const response = await agent.call('POST', AGENT_PATHS.missing, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys: batch }),
    });
    const absent = absentOf(await response?.json(), new Set(batch));
    if (absent === undefined) {
      throw new Error(
        `the deploy agent at ${agent.url.host} did not say which blobs the bucket lacks; it is not the agent this version of upwind deploys`,
      );
    }
    for (const key of absent) {
      missing.add(key);
    }
  }
  return missing;
}

/**
 * Put every blob staging will read in the bucket, where it is not already: the digest of each
 * checked against the build's own, so what goes up is what the build named.
 */
export async function uploadBuildBlobs(
  agent: AgentClient,
  bundleDir: string,
  bundle: DeploymentBundle,
): Promise<{ readonly uploaded: number; readonly held: number }> {
  const refs = stagedBlobs(bundle);
  const missing = await missingOf(
    agent,
    refs.map((ref) => blobObjectKey(ref.sha256)),
  );
  const queue = refs.filter((ref) => missing.has(blobObjectKey(ref.sha256)));
  const send = async (): Promise<void> => {
    for (let ref = queue.shift(); ref !== undefined; ref = queue.shift()) {
      const bytes = await localBlob(bundleDir, ref.sha256);
      const digest =
        bytes === undefined ? undefined : createHash('sha256').update(bytes).digest('hex');
      if (bytes === undefined || digest !== ref.sha256 || bytes.byteLength !== ref.byteLength) {
        throw new Error(`the build's blob ${ref.sha256} is missing or not the bytes it names`);
      }
      await agent.call('PUT', blob(blobObjectKey(ref.sha256)), {
        headers: { 'content-type': ref.contentType },
        body: bodyOf(bytes),
      });
    }
  };
  const uploaded = missing.size;
  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, send));
  return { uploaded, held: refs.length - uploaded };
}

/** A deploy target through the agent, with its cache's retirement as well. */
export type RemoteTarget = DeployTarget & {
  readonly cache: DeployTarget['cache'] & {
    retireScope(input: RetireScopeInput): Promise<RetireScopeResult>;
  };
};

/** The deploy target a build is staged and published through, once its blobs are up. */
export function remoteTarget(agent: AgentClient, bundleDir: string): RemoteTarget {
  return targetThrough(agent, (sha256) => localBlob(bundleDir, sha256));
}

/**
 * The deploy target a deployment is staged through again, with no build of it here — a rollback's:
 * its blobs are read back from the bucket a deploy put them in, and checked all the same.
 */
export function storedTarget(agent: AgentClient): RemoteTarget {
  return targetThrough(agent, async (sha256) => {
    const stored = await agent.call('GET', blob(blobObjectKey(sha256)));
    return bytesOf(stored);
  });
}

function targetThrough(
  agent: AgentClient,
  read: (sha256: string) => Promise<Uint8Array | undefined>,
): RemoteTarget {
  const call = async <T>(route: string, input: unknown): Promise<T> => {
    const response = await agent.call('POST', route, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (response === undefined) {
      throw new Error(`the deploy agent has no ${route}`);
    }
    return (await response.json()) as T;
  };
  return {
    // In the bucket already; staging reads each all the same, to check it.
    blobs: { uploaded: true, read },
    bucket: {
      get: async (key) => bytesOf(await agent.call('GET', blob(key))),
      put: async (key, value, options) => {
        await agent.call('PUT', blob(key), {
          headers: {
            'content-type': options.contentType,
            ...metadataHeader(options.customMetadata),
          },
          body: bodyOf(value),
        });
      },
    },
    edgeState: {
      get: async (key) => bytesOf(await agent.call('GET', kv(key))),
      put: async (key, value, metadata) => {
        await agent.call('PUT', kv(key), {
          headers: metadataHeader(metadata),
          body: bodyOf(value),
        });
      },
    },
    cache: {
      seedScope: (input: SeedScopeInput) => call<SeedScopeResult>(AGENT_PATHS.seedScope, input),
      seedEntries: (input: SeedEntriesInput) =>
        call<SeedEntriesResult>(AGENT_PATHS.seedEntries, input),
      retireScope: (input: RetireScopeInput) =>
        call<RetireScopeResult>(AGENT_PATHS.retireScope, input),
    },
  };
}
