import {
  type ArtifactUpload,
  type CacheHost,
  CacheHostError,
  type UploadedArtifact,
} from './host.ts';
import { callsBehind } from './turns.ts';

/**
 * An attempt's uploads, in the request's turns for the calls behind its work, which the data
 * cache's writes take too (`CALLS_BEHIND_AT_ONCE`): a page's every output at once took all six a
 * Function has. Its small outputs go in one call, in one turn, where the host has one
 * (`uploadArtifacts`): one call each, three at a time, they were most of a publish — over a hosted
 * deployment, five outputs of a few kilobytes took 0.8 s of the 1.3 s a publish took.
 *
 * An output that fails to upload fails the attempt (`publish`), and the outputs still waiting for
 * their turn are not sent after it: no commit would name them, and they would hold the turns the
 * request's writes wait for. Said inside the turn, before it is given back: the turn wakes the next
 * output as it is given back, ahead of anything that waits on this one.
 */

const KIB = 1024;
const BATCHED_UPLOAD_KIB = 64;
const BATCHED_UPLOADS_KIB = 512;
/** An output no larger than this goes in one call with the attempt's others (`uploadArtifacts`). */
const BATCHED_UPLOAD_BYTES = BATCHED_UPLOAD_KIB * KIB;
/** No more outputs than this in one call, nor more bytes in all than that. */
const BATCHED_UPLOADS = 16;
const BATCHED_UPLOADS_BYTES = BATCHED_UPLOADS_KIB * KIB;

/**
 * Hosts whose `uploadArtifacts` answered that there is no such call — one from before it — whose
 * outputs go each on its own from then on.
 */
const unbatched = new WeakSet<CacheHost>();

/** `error` says the host has no `uploadArtifacts` call after all (`unsupported`, `CacheHost`). */
function noSuchCall(error: unknown): boolean {
  return error instanceof CacheHostError && error.code === 'unsupported';
}

/** `value` is what a host answers an upload with: the name and length of the bytes it stored. */
function isUploaded(value: unknown): value is UploadedArtifact {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly sha256?: unknown }).sha256 === 'string' &&
    typeof (value as { readonly byteLength?: unknown }).byteLength === 'number'
  );
}

/**
 * The answers of a batch of `count`, one for each output in their order, or why they are not:
 * every answer is checked before any output is answered with one.
 */
function answersFor(count: number, answers: readonly unknown[]): UploadedArtifact[] {
  if (answers.length !== count) {
    throw new Error(`the host answered ${answers.length} of ${count} uploads`);
  }
  return answers.map((answer, index) => {
    if (!isUploaded(answer)) {
      throw new TypeError(`the host answered no upload ${index}`);
    }
    return answer;
  });
}

/** Settle `answer` as `work` settles. Never rejects. */
async function settleAs<T>(answer: PromiseWithResolvers<T>, work: Promise<T>): Promise<void> {
  try {
    answer.resolve(await work);
  } catch (error) {
    answer.reject(error);
  }
}

/** An output handed over for the call that carries the attempt's small ones together. */
interface Batched {
  readonly pending: ArtifactUpload;
  readonly answer: PromiseWithResolvers<UploadedArtifact>;
}

/** An attempt's uploads: each output handed to `send`, the small ones sent together by `flush`. */
export interface Uploader {
  readonly send: (
    role: ArtifactUpload['role'],
    bytes: Uint8Array,
    contentType: string,
  ) => Promise<UploadedArtifact>;
  /**
   * Send the small outputs handed to `send`, in one call, once every output has been; settled once
   * each of them has its answer. Never rejects: an output's failure is its own promise's.
   */
  readonly flush: () => Promise<void>;
}

export function uploaderFor(
  host: CacheHost,
  lease: { readonly attemptId: string; readonly fencingToken: number },
): Uploader {
  const turn = callsBehind();
  let failed = false;
  const own = (pending: ArtifactUpload): Promise<UploadedArtifact> => {
    return turn(async () => {
      if (failed) {
        throw new Error('not uploaded: an output beside it failed to upload');
      }
      try {
        return await host.uploadArtifact(pending);
      } catch (error) {
        failed = true;
        throw error;
      }
    });
  };
  const batch: Batched[] = [];
  let batchedBytes = 0;
  const batches = host.uploadArtifacts !== undefined && !unbatched.has(host);
  const sendBatch = async (sent: readonly Batched[]): Promise<void> => {
    try {
      // Failed or not is said inside the turn, as `own` says it: the turn wakes the next output as
      // it is given back, and an output waiting on a batch that failed is not sent after it.
      const answers = await turn(async () => {
        if (failed) {
          throw new Error('not uploaded: an output beside it failed to upload');
        }
        try {
          const answered = await host.uploadArtifacts?.(sent.map(({ pending }) => pending));
          return answersFor(sent.length, answered ?? []);
        } catch (error) {
          failed ||= !noSuchCall(error);
          throw error;
        }
      });
      for (const [index, answered] of answers.entries()) {
        sent[index]?.answer.resolve(answered);
      }
    } catch (error) {
      if (noSuchCall(error)) {
        unbatched.add(host);
        await Promise.all(sent.map(async ({ pending, answer }) => settleAs(answer, own(pending))));
        return;
      }
      for (const { answer } of sent) {
        answer.reject(error);
      }
    }
  };
  return {
    send: (role, bytes, contentType) => {
      const pending: ArtifactUpload = { ...lease, role, bytes, contentType };
      if (
        batches &&
        bytes.byteLength <= BATCHED_UPLOAD_BYTES &&
        batch.length < BATCHED_UPLOADS &&
        batchedBytes + bytes.byteLength <= BATCHED_UPLOADS_BYTES
      ) {
        const answer = Promise.withResolvers<UploadedArtifact>();
        batch.push({ pending, answer });
        batchedBytes += bytes.byteLength;
        return answer.promise;
      }
      return own(pending);
    },
    flush: async () => {
      const sent = batch.splice(0);
      const [only] = sent;
      if (only !== undefined && sent.length === 1) {
        await settleAs(only.answer, own(only.pending));
      } else if (sent.length > 1) {
        await sendBatch(sent);
      }
    },
  };
}
