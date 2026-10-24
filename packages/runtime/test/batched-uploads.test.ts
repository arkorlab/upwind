import { toHex } from '@stayingupwind/core/util';
import { describe, expect, it, type Mock, vi } from 'vitest';

import { withRequestContext } from '../src/cache/context.ts';
import {
  type ArtifactUpload,
  type CacheHost,
  CacheHostError,
  type UploadedArtifact,
} from '../src/cache/host.ts';
import { CALLS_BEHIND_AT_ONCE } from '../src/cache/turns.ts';
import { uploaderFor } from '../src/cache/uploads.ts';
import { requestKeeping } from './request-context.ts';

/**
 * An attempt's outputs on their way to the host (`uploaderFor`). An output of 64 KiB or less is
 * held until `flush`, and goes up with the attempt's other small ones in one call
 * (`uploadArtifacts`) — sixteen of them at the most, and 512 KiB in all — each answered with what
 * the host answered at its place, once every answer has been found to be one; one with no other
 * beside it goes up on its own. A larger output, and one past what the call carries, goes up on its
 * own (`uploadArtifact`) at once. A host with no such call has every output sent on its own, and so
 * does a host that says it has none after all (`unsupported`), from then on — an attempt that was
 * handed its outputs before another learned so included. An output whose content type the call
 * would not carry goes up on its own too. Any other failure of the call — a 404 among them — is the
 * failure of every output in it, and of the attempt: nothing of it is sent after that, not even an
 * output already waiting for its turn; and so is an answer that is not one for the output at its
 * place, a gap in the answers included.
 */

const KIB = 1024;
/** The largest output that goes up in one call with the others. */
const SMALL_BYTES = 64 * KIB;
const LEASE = { attemptId: 'attempt-uploads', fencingToken: 7 };
const NEXT_LEASE = { attemptId: 'attempt-next', fencingToken: 8 };
const HTML = 'text/html; charset=utf-8';
const RSC = 'text/x-component';
const JSON_TYPE = 'application/json';
const NOT_UPLOADED = 'not uploaded: an output beside it failed to upload';
/**
 * Failures of the call that leave the host's call standing: every one but `unsupported`, a 404
 * among them. Whether a 404 means there is no such call is the host's to say.
 */
const REFUSALS = [
  { status: 409, code: 'quota_exceeded', message: 'full' },
  { status: 404, code: 'not_found', message: 'no such attempt' },
  { status: 404, code: 'internal', message: 'cache gateway answered 404' },
];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type StoreOne = (upload: ArtifactUpload) => Promise<UploadedArtifact>;
type StoreMany = (uploads: readonly ArtifactUpload[]) => Promise<readonly UploadedArtifact[]>;

/** A host that stores what it is sent: an output a call, or several in one. */
interface FakeHost {
  readonly host: CacheHost;
  readonly uploadArtifact: Mock<StoreOne>;
  readonly uploadArtifacts: Mock<StoreMany>;
}

/** An output the host was sent on its own and has not answered yet (`holdUploads`). */
interface Held {
  readonly bytes: Uint8Array;
  readonly answer: PromiseWithResolvers<UploadedArtifact>;
}

/** `size` bytes that start with `name`, zeros after it: an output the host's answer names. */
function output(name: string, size = name.length): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(encoder.encode(name));
  return bytes;
}

/** The name an output starts with (`output`). */
function nameOf(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/**
 * What the host answers for an output it stored: a digest that names it — its name in hex, padded
 * to the length of a SHA-256 — and its length.
 */
function stored(bytes: Uint8Array): UploadedArtifact {
  const named = toHex(encoder.encode(nameOf(bytes)));
  return { sha256: named.padEnd(64, '0').slice(0, 64), byteLength: bytes.byteLength };
}

/** The attempt's upload of `bytes`, as the host is handed it. */
function upload(
  role: ArtifactUpload['role'],
  bytes: Uint8Array,
  contentType: string,
): ArtifactUpload {
  return { ...LEASE, role, bytes, contentType };
}

/** A host with the call that takes several outputs at once. */
function batchingHost(): FakeHost {
  const uploadArtifact = vi.fn<StoreOne>((one) => Promise.resolve(stored(one.bytes)));
  const uploadArtifacts = vi.fn<StoreMany>((many) =>
    Promise.resolve(many.map(({ bytes }) => stored(bytes))),
  );
  return {
    host: { uploadArtifact, uploadArtifacts } as unknown as CacheHost,
    uploadArtifact,
    uploadArtifacts,
  };
}

/** A host from before batched uploads: each output stored by a call of its own. */
function unbatchedHost(): Omit<FakeHost, 'uploadArtifacts'> {
  const uploadArtifact = vi.fn<StoreOne>((one) => Promise.resolve(stored(one.bytes)));
  return { host: { uploadArtifact } as unknown as CacheHost, uploadArtifact };
}

/** The outputs `fake` is sent on its own from now on, each held unanswered until a test answers. */
function holdUploads(fake: FakeHost): Held[] {
  const held: Held[] = [];
  fake.uploadArtifact.mockImplementation((one) => {
    const answer = Promise.withResolvers<UploadedArtifact>();
    held.push({ bytes: one.bytes, answer });
    return answer.promise;
  });
  return held;
}

/** The outputs the host stored each on its own, by name, in the order it was asked to. */
function storedAlone(fake: Pick<FakeHost, 'uploadArtifact'>): string[] {
  return fake.uploadArtifact.mock.calls.map(([one]) => nameOf(one.bytes));
}

/** The outputs the host stored together, by name: a list for each call. */
function storedTogether(fake: FakeHost): string[][] {
  return fake.uploadArtifacts.mock.calls.map(([many]) => many.map(({ bytes }) => nameOf(bytes)));
}

/** Once every callback queued so far has run: what goes up at once has gone by then. */
async function queuedRun(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('an attempt’s uploads', () => {
  it('sends the small outputs in one call once flushed, in the order they were handed over', async () => {
    const fake = batchingHost();
    const uploader = uploaderFor(fake.host, LEASE);
    const body = output('body');
    const payload = output('payload');
    const segment = output('segment', SMALL_BYTES);
    const sent = Promise.all([
      uploader.send('html', body, HTML),
      uploader.send('rsc', payload, RSC),
      uploader.send('segment', segment, RSC),
    ]);
    await queuedRun();

    expect(fake.uploadArtifacts).not.toHaveBeenCalled();

    await uploader.flush();

    expect(fake.uploadArtifacts).toHaveBeenCalledExactlyOnceWith([
      upload('html', body, HTML),
      upload('rsc', payload, RSC),
      upload('segment', segment, RSC),
    ]);
    expect(fake.uploadArtifact).not.toHaveBeenCalled();
    await expect(sent).resolves.toStrictEqual([stored(body), stored(payload), stored(segment)]);
  });

  it('sends an output over 64 KiB on its own at once, and the small ones in one call', async () => {
    const fake = batchingHost();
    const uploader = uploaderFor(fake.host, LEASE);
    const body = output('body', SMALL_BYTES + 1);
    const payload = output('payload');
    const segment = output('segment');
    const sent = Promise.all([
      uploader.send('html', body, HTML),
      uploader.send('rsc', payload, RSC),
      uploader.send('segment', segment, RSC),
    ]);
    await queuedRun();

    expect(fake.uploadArtifact).toHaveBeenCalledExactlyOnceWith(upload('html', body, HTML));

    await uploader.flush();

    expect(storedTogether(fake)).toStrictEqual([['payload', 'segment']]);
    expect(storedAlone(fake)).toStrictEqual(['body']);
    await expect(sent).resolves.toStrictEqual([stored(body), stored(payload), stored(segment)]);
  });

  it('sends a small output with no other beside it on its own', async () => {
    const fake = batchingHost();
    const uploader = uploaderFor(fake.host, LEASE);
    const payload = output('payload');
    const sent = uploader.send('rsc', payload, RSC);
    await queuedRun();

    expect(fake.uploadArtifact).not.toHaveBeenCalled();

    await uploader.flush();

    expect(fake.uploadArtifact).toHaveBeenCalledExactlyOnceWith(upload('rsc', payload, RSC));
    expect(fake.uploadArtifacts).not.toHaveBeenCalled();
    await expect(sent).resolves.toStrictEqual(stored(payload));
  });

  it('sends every output on its own, at once, to a host with no call for several', async () => {
    const fake = unbatchedHost();
    const uploader = uploaderFor(fake.host, LEASE);
    const body = output('body');
    const payload = output('payload');
    const segment = output('segment');
    const sent = Promise.all([
      uploader.send('html', body, HTML),
      uploader.send('rsc', payload, RSC),
      uploader.send('segment', segment, RSC),
    ]);
    await queuedRun();

    expect(storedAlone(fake)).toStrictEqual(['body', 'payload', 'segment']);

    await uploader.flush();

    expect(fake.uploadArtifact).toHaveBeenCalledTimes(3);
    await expect(sent).resolves.toStrictEqual([stored(body), stored(payload), stored(segment)]);
  });

  /**
   * A host whose store has no such call says so (`unsupported`): a gateway from before the call, as
   * the Function's gateway client reads its answer. The outputs it was handed go up each on its
   * own, and so does every output of a later attempt sent to that host.
   */
  it('sends each output on its own where the host has no such call, and from then on', async () => {
    const fake = batchingHost();
    fake.uploadArtifacts.mockRejectedValue(
      new CacheHostError('the gateway takes no batch of uploads', {
        code: 'unsupported',
        status: 404,
      }),
    );
    const uploader = uploaderFor(fake.host, LEASE);
    const body = output('body');
    const payload = output('payload');
    const sent = Promise.all([
      uploader.send('html', body, HTML),
      uploader.send('rsc', payload, RSC),
    ]);
    await uploader.flush();

    expect(storedTogether(fake)).toStrictEqual([['body', 'payload']]);
    expect(storedAlone(fake)).toStrictEqual(['body', 'payload']);
    await expect(sent).resolves.toStrictEqual([stored(body), stored(payload)]);

    const next = uploaderFor(fake.host, NEXT_LEASE);
    const segment = output('segment');
    const data = output('data');
    const sentNext = Promise.all([
      next.send('segment', segment, RSC),
      next.send('pages-data', data, JSON_TYPE),
    ]);
    await queuedRun();

    expect(storedAlone(fake)).toStrictEqual(['body', 'payload', 'segment', 'data']);

    await next.flush();

    expect(storedTogether(fake)).toStrictEqual([['body', 'payload']]);
    await expect(sentNext).resolves.toStrictEqual([stored(segment), stored(data)]);
  });

  it('sends each output of an attempt handed them before another learned the host has no such call on its own', async () => {
    const fake = batchingHost();
    fake.uploadArtifacts.mockRejectedValue(
      new CacheHostError('the gateway takes no batch of uploads', {
        code: 'unsupported',
        status: 404,
      }),
    );
    const first = uploaderFor(fake.host, LEASE);
    const next = uploaderFor(fake.host, NEXT_LEASE);
    const body = output('body');
    const payload = output('payload');
    const segment = output('segment');
    const data = output('data');
    const sent = Promise.all([first.send('html', body, HTML), first.send('rsc', payload, RSC)]);
    const sentNext = Promise.all([
      next.send('segment', segment, RSC),
      next.send('pages-data', data, JSON_TYPE),
    ]);
    await first.flush();
    await next.flush();

    // Asked once: the second attempt's outputs, held since before the answer, go up on their own.
    expect(storedTogether(fake)).toStrictEqual([['body', 'payload']]);
    expect(storedAlone(fake)).toStrictEqual(['body', 'payload', 'segment', 'data']);
    await expect(sent).resolves.toStrictEqual([stored(body), stored(payload)]);
    await expect(sentNext).resolves.toStrictEqual([stored(segment), stored(data)]);
  });

  it.each(REFUSALS)(
    'fails every output in a call refused with $status $code, and flushes all the same',
    async ({ status, code, message }) => {
      const fake = batchingHost();
      const refusal = new CacheHostError(message, { code, status });
      fake.uploadArtifacts.mockRejectedValueOnce(refusal);
      const uploader = uploaderFor(fake.host, LEASE);
      const settled = Promise.allSettled([
        uploader.send('html', output('body'), HTML),
        uploader.send('rsc', output('payload'), RSC),
      ]);

      await expect(uploader.flush()).resolves.toBeUndefined();
      await expect(settled).resolves.toStrictEqual([
        { status: 'rejected', reason: refusal },
        { status: 'rejected', reason: refusal },
      ]);
      expect(fake.uploadArtifact).not.toHaveBeenCalled();
    },
  );

  it.each(REFUSALS)(
    'sends the next attempt’s small outputs in one call after a $status $code refusal',
    async ({ status, code, message }) => {
      const fake = batchingHost();
      fake.uploadArtifacts.mockRejectedValueOnce(new CacheHostError(message, { code, status }));
      const refused = uploaderFor(fake.host, LEASE);
      const settled = Promise.allSettled([
        refused.send('html', output('body'), HTML),
        refused.send('rsc', output('payload'), RSC),
      ]);
      await refused.flush();
      await settled;
      const next = uploaderFor(fake.host, NEXT_LEASE);
      const segment = output('segment');
      const data = output('data');
      const sent = Promise.all([
        next.send('segment', segment, RSC),
        next.send('pages-data', data, JSON_TYPE),
      ]);
      await next.flush();

      expect(storedTogether(fake)).toStrictEqual([
        ['body', 'payload'],
        ['segment', 'data'],
      ]);
      expect(fake.uploadArtifact).not.toHaveBeenCalled();
      await expect(sent).resolves.toStrictEqual([stored(segment), stored(data)]);
    },
  );

  it('sends sixteen small outputs in one call at the most, and those past them on their own at once', async () => {
    const fake = batchingHost();
    const uploader = uploaderFor(fake.host, LEASE);
    const segments = Array.from({ length: 18 }, (_value, index) => output(`segment ${index}`));
    const sent = Promise.all(segments.map((bytes) => uploader.send('segment', bytes, RSC)));
    await queuedRun();

    expect(storedAlone(fake)).toStrictEqual(['segment 16', 'segment 17']);

    await uploader.flush();

    expect(storedTogether(fake)).toStrictEqual([
      segments.slice(0, 16).map((bytes) => nameOf(bytes)),
    ]);
    expect(fake.uploadArtifact).toHaveBeenCalledTimes(2);
    await expect(sent).resolves.toStrictEqual(segments.map((bytes) => stored(bytes)));
  });

  it('sends 512 KiB in one call at the most, and the outputs past it on their own at once', async () => {
    const fake = batchingHost();
    const uploader = uploaderFor(fake.host, LEASE);
    // Eight outputs of 64 KiB fill the call to the byte; even a few bytes more go up on their own.
    const segments = Array.from({ length: 8 }, (_value, index) =>
      output(`segment ${index}`, SMALL_BYTES),
    );
    const tail = output('tail');
    const outputs = [...segments, tail];
    const sent = Promise.all(outputs.map((bytes) => uploader.send('segment', bytes, RSC)));
    await queuedRun();

    expect(storedAlone(fake)).toStrictEqual(['tail']);

    await uploader.flush();

    expect(storedTogether(fake)).toStrictEqual([segments.map((bytes) => nameOf(bytes))]);
    expect(storedAlone(fake)).toStrictEqual(['tail']);
    await expect(sent).resolves.toStrictEqual(outputs.map((bytes) => stored(bytes)));
  });

  it('fails every output in a call the host answered fewer of than it was sent', async () => {
    const fake = batchingHost();
    fake.uploadArtifacts.mockImplementationOnce((many) =>
      Promise.resolve(many.slice(1).map(({ bytes }) => stored(bytes))),
    );
    const uploader = uploaderFor(fake.host, LEASE);
    const settled = Promise.allSettled([
      uploader.send('html', output('body'), HTML),
      uploader.send('rsc', output('payload'), RSC),
      uploader.send('segment', output('segment'), RSC),
    ]);

    await expect(uploader.flush()).resolves.toBeUndefined();

    const miscounted = {
      status: 'rejected',
      reason: new Error('the host answered 2 of 3 uploads'),
    };

    await expect(settled).resolves.toStrictEqual([miscounted, miscounted, miscounted]);
    expect(fake.uploadArtifact).not.toHaveBeenCalled();
  });

  /**
   * As many answers as outputs, the last of them none, or not one an upload is answered with: every
   * answer is looked at before any output is answered, so the outputs ahead of it are not answered
   * either.
   */
  it.each([
    ['missing', undefined],
    ['null', null],
    ['without the name of the bytes', { byteLength: 7 }],
    [
      'naming the bytes other than by their SHA-256',
      { sha256: 'sha256 of segment', byteLength: 7 },
    ],
    ['of another length than the output’s', { ...stored(output('segment')), byteLength: 6 }],
    ['of no length', { ...stored(output('segment')), byteLength: NaN }],
  ] as const)(
    'fails every output in a call with an answer %s, and answers none of them',
    async (_answer, last) => {
      const fake = batchingHost();
      fake.uploadArtifacts.mockImplementationOnce((many) => {
        const answers = many.map(({ bytes }, index) =>
          index === many.length - 1 ? last : stored(bytes),
        );
        return Promise.resolve(answers as unknown as UploadedArtifact[]);
      });
      const uploader = uploaderFor(fake.host, LEASE);
      const settled = Promise.allSettled([
        uploader.send('html', output('body'), HTML),
        uploader.send('rsc', output('payload'), RSC),
        uploader.send('segment', output('segment'), RSC),
      ]);

      await expect(uploader.flush()).resolves.toBeUndefined();

      const unanswered = {
        status: 'rejected',
        reason: new TypeError('the host answered no upload 2 of 7 bytes'),
      };

      await expect(settled).resolves.toStrictEqual([unanswered, unanswered, unanswered]);
      expect(fake.uploadArtifact).not.toHaveBeenCalled();
    },
  );

  it('fails every output in a call whose answers have a gap where one should be', async () => {
    const fake = batchingHost();
    fake.uploadArtifacts.mockImplementationOnce((many) => {
      // As many answers as outputs, and none at the second's place: a walk over the answers would
      // pass it by.
      const answers: UploadedArtifact[] = [];
      for (const [index, { bytes }] of many.entries()) {
        if (index !== 1) {
          answers[index] = stored(bytes);
        }
      }
      return Promise.resolve(answers);
    });
    const uploader = uploaderFor(fake.host, LEASE);
    const settled = Promise.allSettled([
      uploader.send('html', output('body'), HTML),
      uploader.send('rsc', output('payload'), RSC),
      uploader.send('segment', output('segment'), RSC),
    ]);

    await expect(uploader.flush()).resolves.toBeUndefined();

    const unanswered = {
      status: 'rejected',
      reason: new TypeError('the host answered no upload 1 of 7 bytes'),
    };

    await expect(settled).resolves.toStrictEqual([unanswered, unanswered, unanswered]);
    expect(fake.uploadArtifact).not.toHaveBeenCalled();
  });

  it.each([
    ['longer than a call carries', `text/plain; profile=${'p'.repeat(256)}`],
    ['of more than printable ASCII', 'text/plain; title=caf\u{E9}'],
  ])('sends an output whose content type is %s on its own', async (_kind, contentType) => {
    const fake = batchingHost();
    const uploader = uploaderFor(fake.host, LEASE);
    const body = output('body');
    const payload = output('payload');
    const route = output('route');
    const sent = Promise.all([
      uploader.send('html', body, HTML),
      uploader.send('route-body', route, contentType),
      uploader.send('rsc', payload, RSC),
    ]);
    await queuedRun();

    expect(storedAlone(fake)).toStrictEqual(['route']);
    expect(fake.uploadArtifact.mock.calls[0]?.[0].contentType).toBe(contentType);

    await uploader.flush();

    expect(storedTogether(fake)).toStrictEqual([['body', 'payload']]);
    await expect(sent).resolves.toStrictEqual([stored(body), stored(route), stored(payload)]);
  });

  /**
   * The large outputs hold every turn the attempt has, and the call for the small ones waits behind
   * them. One of them fails, and the call is not made: no commit would name what it carried.
   */
  it('sends no call for the small outputs once an output sent on its own has failed', async () => {
    const fake = batchingHost();
    const held = holdUploads(fake);
    const uploader = uploaderFor(fake.host, LEASE);
    const large = Array.from({ length: CALLS_BEHIND_AT_ONCE }, (_value, index) =>
      output(`body ${index}`, SMALL_BYTES + 1),
    );
    const settled = Promise.allSettled([
      ...large.map((bytes) => uploader.send('html', bytes, HTML)),
      uploader.send('segment', output('segment a'), RSC),
      uploader.send('segment', output('segment b'), RSC),
    ]);
    const flushed = uploader.flush();
    await queuedRun();

    expect(held).toHaveLength(CALLS_BEHIND_AT_ONCE);

    const refusal = new CacheHostError('lease lost', { code: 'lease_expired', status: 409 });
    const [failing, ...rest] = held;
    failing!.answer.reject(refusal);
    await flushed;
    for (const { bytes, answer } of rest) {
      answer.resolve(stored(bytes));
    }
    const notUploaded = { status: 'rejected', reason: new Error(NOT_UPLOADED) };

    await expect(settled).resolves.toStrictEqual([
      { status: 'rejected', reason: refusal },
      ...large.slice(1).map((bytes) => ({ status: 'fulfilled', value: stored(bytes) })),
      notUploaded,
      notUploaded,
    ]);
    expect(fake.uploadArtifacts).not.toHaveBeenCalled();
  });

  it('sends none of the outputs handed over after a call the host refused', async () => {
    const fake = batchingHost();
    fake.uploadArtifacts.mockRejectedValueOnce(
      new CacheHostError('full', { code: 'quota_exceeded', status: 409 }),
    );
    const uploader = uploaderFor(fake.host, LEASE);
    const refused = Promise.allSettled([
      uploader.send('html', output('body'), HTML),
      uploader.send('rsc', output('payload'), RSC),
    ]);
    await uploader.flush();
    await refused;
    const after = Promise.allSettled([
      uploader.send('html', output('large', SMALL_BYTES + 1), HTML),
      uploader.send('segment', output('segment a'), RSC),
      uploader.send('segment', output('segment b'), RSC),
    ]);
    await uploader.flush();
    const notUploaded = { status: 'rejected', reason: new Error(NOT_UPLOADED) };

    await expect(after).resolves.toStrictEqual([notUploaded, notUploaded, notUploaded]);
    expect(fake.uploadArtifact).not.toHaveBeenCalled();
    expect(storedTogether(fake)).toStrictEqual([['body', 'payload']]);
  });

  /**
   * A request's turns wake the output waiting for one as soon as one is given back, ahead of
   * anything that waits on the call that gave it back. That the call failed is said before its turn
   * is given back, or the output waiting for that turn goes up after it, for an attempt no commit
   * will name.
   */
  it('sends no output still waiting for its turn once the call ahead of it is refused, in a request', async () => {
    const fake = batchingHost();
    const held = holdUploads(fake);
    const call = Promise.withResolvers<readonly UploadedArtifact[]>();
    fake.uploadArtifacts.mockImplementation(async () => call.promise);
    const refusal = new CacheHostError('full', { code: 'quota_exceeded', status: 409 });
    // With the call, these take every turn the request has for the calls behind its work.
    const large = Array.from({ length: CALLS_BEHIND_AT_ONCE - 1 }, (_value, index) =>
      output(`body ${index}`, SMALL_BYTES + 1),
    );

    const late = await withRequestContext(requestKeeping(undefined, []), async () => {
      const uploader = uploaderFor(fake.host, LEASE);
      const sent = Promise.allSettled([
        ...large.map((bytes) => uploader.send('html', bytes, HTML)),
        uploader.send('segment', output('segment a'), RSC),
        uploader.send('segment', output('segment b'), RSC),
      ]);
      const flushed = uploader.flush();
      await queuedRun();
      const waiting = Promise.allSettled([
        uploader.send('html', output('late', SMALL_BYTES + 1), HTML),
      ]);
      await queuedRun();

      expect(storedAlone(fake)).toStrictEqual(large.map((bytes) => nameOf(bytes)));

      call.reject(refusal);
      await flushed;
      for (const { bytes, answer } of held) {
        answer.resolve(stored(bytes));
      }
      await sent;
      return waiting;
    });

    expect(late).toStrictEqual([{ status: 'rejected', reason: new Error(NOT_UPLOADED) }]);
    expect(storedAlone(fake)).toStrictEqual(large.map((bytes) => nameOf(bytes)));
    expect(storedTogether(fake)).toStrictEqual([['segment a', 'segment b']]);
  });
});
