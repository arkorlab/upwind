import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { DeployTarget } from '@stayingupwind/deploy/deploy';
import type {
  SeedEntriesInput,
  SeedEntriesResult,
  SeedScopeInput,
  SeedScopeResult,
} from '@stayingupwind/host/cache';

import { AGENT_ROUTES, METADATA_HEADER } from './workers/protocol.ts';

const HTTP_NOT_FOUND = 404;

/** What a write carries, in an array of its own: a `fetch` body is never a view of shared memory. */
function bodyOf(value: Uint8Array | string): string | Uint8Array<ArrayBuffer> {
  return typeof value === 'string' ? value : new Uint8Array(value);
}

/** Where the agent reads and writes a value of the edge's namespace, and an object of the bucket. */
function kv(key: string): string {
  return `${AGENT_ROUTES.kv}${encodeURIComponent(key)}`;
}

function blob(key: string): string {
  return `${AGENT_ROUTES.blob}${encodeURIComponent(key)}`;
}

/** Whether a read failed for a file that is not there. */
function isMissing(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, 'code') === 'ENOENT';
}

async function refusedBy(response: Response, what: string): Promise<Error> {
  return new Error(
    `the deploy agent answered ${response.status} to ${what}: ${await response.text()}`,
  );
}

/**
 * Where a build is deployed to on a stack (`DeployTarget`): its blobs from the directory it was
 * built in, and the stack's stores and cache authority through its deploy agent, at `agent`.
 */
export function agentTarget(agent: URL, bundleDir: string): DeployTarget {
  const read = async (route: string): Promise<Uint8Array | undefined> => {
    const response = await fetch(new URL(route, agent));
    if (response.status === HTTP_NOT_FOUND) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) {
      throw await refusedBy(response, `GET ${route}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };
  const write = async (
    route: string,
    value: Uint8Array | string,
    headers: Readonly<Record<string, string>>,
  ): Promise<void> => {
    const response = await fetch(new URL(route, agent), {
      method: 'PUT',
      headers,
      body: bodyOf(value),
    });
    if (!response.ok) {
      throw await refusedBy(response, `PUT ${route}`);
    }
    await response.body?.cancel();
  };
  const call = async <T>(route: string, input: unknown): Promise<T> => {
    const response = await fetch(new URL(route, agent), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw await refusedBy(response, `POST ${route}`);
    }
    return (await response.json()) as T;
  };
  return {
    blobs: {
      // Where the build left them; staging copies each to the bucket, as an upload would have.
      uploaded: false,
      read: async (sha256) => {
        try {
          return new Uint8Array(await readFile(path.join(bundleDir, 'blobs', sha256)));
        } catch (error) {
          if (isMissing(error)) {
            return;
          }
          throw error;
        }
      },
    },
    bucket: {
      get: (key) => read(blob(key)),
      put: (key, value, options) => {
        return write(blob(key), value, {
          'content-type': options.contentType,
          ...(options.customMetadata !== undefined && {
            [METADATA_HEADER]: encodeURIComponent(JSON.stringify(options.customMetadata)),
          }),
        });
      },
    },
    edgeState: {
      get: (key) => read(kv(key)),
      put: (key, value, metadata) => {
        return write(
          kv(key),
          value,
          metadata === undefined
            ? {}
            : { [METADATA_HEADER]: encodeURIComponent(JSON.stringify(metadata)) },
        );
      },
    },
    cache: {
      seedScope: (input: SeedScopeInput) => call<SeedScopeResult>(AGENT_ROUTES.seedScope, input),
      seedEntries: (input: SeedEntriesInput) =>
        call<SeedEntriesResult>(AGENT_ROUTES.seedEntries, input),
    },
  };
}
