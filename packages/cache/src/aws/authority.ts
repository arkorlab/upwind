import type {
  ArtifactUpload,
  AttemptRequest,
  CacheHost,
  CommitRequest,
  DataReadRequest,
  DataWriteRequest,
  FailRequest,
  InvalidateRequest,
} from '@stayingupwind/runtime/cache-host';

import { AwsAttempts } from './attempts.ts';
import { AwsBase } from './base.ts';
import { AwsData } from './data.ts';

/** One CacheHost contract shared by both providers. */
export class AwsAuthority extends AwsBase implements CacheHost {
  readonly #attempts = new AwsAttempts(this);
  readonly #data = new AwsData(this);
  startAttempt(request: AttemptRequest) {
    return this.#attempts.startAttempt(request);
  }
  uploadArtifact(upload: ArtifactUpload) {
    return this.#attempts.uploadArtifact(upload);
  }
  uploadArtifacts(uploads: readonly ArtifactUpload[]) {
    return this.#attempts.uploadArtifacts(uploads);
  }
  heartbeat(attemptId: string, fencingToken: number) {
    return this.#attempts.heartbeat(attemptId, fencingToken);
  }
  commit(attemptId: string, request: CommitRequest) {
    return this.#attempts.commit(attemptId, request);
  }
  fail(attemptId: string, request: FailRequest) {
    return this.#attempts.fail(attemptId, request);
  }
  readRecord(entryId: string, signal?: AbortSignal) {
    return this.#data.readRecord(entryId, signal);
  }
  readArtifact(artifactId: string) {
    return this.#data.readArtifact(artifactId);
  }
  getData(request: DataReadRequest) {
    return this.#data.getData(request);
  }
  setData(request: DataWriteRequest) {
    return this.#data.setData(request);
  }
  getTags(values: readonly string[]) {
    return this.#data.getTags(values);
  }
  tagsDelta(since: number) {
    return this.#data.tagsDelta(since);
  }
  invalidate(request: InvalidateRequest) {
    return this.#data.invalidate(request);
  }
}
