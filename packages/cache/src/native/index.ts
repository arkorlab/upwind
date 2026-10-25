import { URL } from 'node:url';
import { Worker } from 'node:worker_threads';

import type {
  ArtifactUpload,
  AttemptOutcome,
  AttemptRequest,
  CacheHost,
  CacheHostBinding,
  CommitOutcome,
  CommitRequest,
  DataRead,
  DataReadRequest,
  DataWriteRequest,
  DataWritten,
  FailRequest,
  InvalidateOutcome,
  InvalidateRequest,
  TagDelta,
  TagInvalidations,
  UploadedArtifact,
} from '@stayingupwind/runtime/cache-host';

import type { CacheAnswer, CacheCall, NativeCacheOptions } from './protocol.ts';

export type { NativeCacheOptions, NativeCacheSeed } from './protocol.ts';

export interface NativeCache {
  readonly binding: CacheHostBinding;
  close(): Promise<void>;
}

/** SQLite and cache bookkeeping run in this worker, never on the server's event loop. */
class NativeHost implements CacheHost {
  readonly #worker: Worker;
  readonly #pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
    }
  >();
  #nextId = 0;
  #closing: Promise<void> | undefined;
  #failed: Error | undefined;

  constructor(options: NativeCacheOptions) {
    const { workerUrl, ...workerData } = options;
    this.#worker = new Worker(
      workerUrl === undefined ? new URL('worker.ts', import.meta.url) : new URL(workerUrl.href),
      {
        workerData,
        execArgv: process.execArgv.filter((argument) => !argument.startsWith('--input-type')),
      },
    );
    this.#worker.on('message', (answer: CacheAnswer) => {
      const pending = this.#pending.get(answer.id);
      if (pending === undefined) return;
      this.#pending.delete(answer.id);
      if ('error' in answer) {
        pending.reject(new Error(answer.error.message));
      } else {
        pending.resolve(answer.value);
      }
    });
    this.#worker.on('error', (error: Error) => {
      this.#fail(error);
    });
    this.#worker.on('exit', (code) => {
      if (code !== 0 || this.#pending.size > 0) {
        this.#fail(new Error(`native cache worker exited with code ${String(code)}`));
      }
    });
  }

  #fail(error: Error): void {
    this.#failed = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #call<T>(method: string, args: readonly unknown[], closing = false): Promise<T> {
    if (this.#failed !== undefined) return Promise.reject(this.#failed);
    if (!closing && this.#closing !== undefined) {
      return Promise.reject(new Error('native cache is closing'));
    }
    this.#nextId += 1;
    const id = this.#nextId;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => {
          resolve(value as T);
        },
        reject,
      });
      try {
        this.#worker.postMessage({ id, method, args } satisfies CacheCall);
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async #closeWorker(): Promise<void> {
    await this.#call<undefined>('close', [], true);
    await this.#worker.terminate();
  }

  ready(): Promise<void> {
    return this.#call('ready', []);
  }

  close(): Promise<void> {
    this.#closing ??= this.#closeWorker();
    return this.#closing;
  }

  startAttempt(request: AttemptRequest): Promise<AttemptOutcome> {
    return this.#call('startAttempt', [request]);
  }

  uploadArtifact(upload: ArtifactUpload): Promise<UploadedArtifact> {
    return this.#call('uploadArtifact', [upload]);
  }

  uploadArtifacts(uploads: readonly ArtifactUpload[]): Promise<readonly UploadedArtifact[]> {
    return this.#call('uploadArtifacts', [uploads]);
  }

  heartbeat(attemptId: string, fencingToken: number): Promise<void> {
    return this.#call('heartbeat', [attemptId, fencingToken]);
  }

  commit(attemptId: string, request: CommitRequest): Promise<CommitOutcome> {
    return this.#call('commit', [attemptId, request]);
  }

  fail(attemptId: string, request: FailRequest): Promise<void> {
    return this.#call('fail', [attemptId, request]);
  }

  async readRecord(entryId: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    signal?.throwIfAborted();
    const answer = await this.#call<Uint8Array | undefined>('readRecord', [entryId]);
    signal?.throwIfAborted();
    return answer;
  }

  readArtifact(artifactId: string): Promise<Uint8Array | undefined> {
    return this.#call('readArtifact', [artifactId]);
  }

  getData(request: DataReadRequest): Promise<DataRead | undefined> {
    return this.#call('getData', [request]);
  }

  setData(request: DataWriteRequest): Promise<DataWritten> {
    return this.#call('setData', [request]);
  }

  getTags(tags: readonly string[]): Promise<TagInvalidations> {
    return this.#call('getTags', [tags]);
  }

  tagsDelta(since: number): Promise<TagDelta> {
    return this.#call('tagsDelta', [since]);
  }

  invalidate(request: InvalidateRequest): Promise<InvalidateOutcome> {
    return this.#call('invalidate', [request]);
  }
}

/** A directory belongs to one immutable deployment and one live Node process. */
export async function createNativeCache(options: NativeCacheOptions): Promise<NativeCache> {
  const host = new NativeHost(options);
  try {
    await host.ready();
  } catch (error) {
    try {
      await host.close();
    } catch {
      // Preserve the startup error.
    }
    throw error;
  }
  return {
    binding: { host, scopeId: options.scopeId, clockOf: (): undefined => undefined },
    close: () => host.close(),
  };
}
