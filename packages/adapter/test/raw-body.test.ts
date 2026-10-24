import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { isStubbedModule, stubSourceFor } from '../src/patches/loader-hooks.ts';
import { RAW_BODY_SOURCE } from '../src/patches/raw-body.ts';

/**
 * The adapter's `raw-body`, held to what Next.js's Pages API body parser reads of the original:
 * the body as a string under an encoding or as bytes without one, the callback form, and the
 * errors — a body over the limit (`entity.too.large`, 413), one that is not as long as its
 * `content-length` says (400), an encoding the runtime does not know (415).
 */

interface RawBodyError extends Error {
  readonly status: number;
  readonly type: string;
}

interface Options {
  readonly encoding?: string | true;
  readonly limit?: string | number;
  readonly length?: string | number;
}

type Callback = (error: Error | null, body?: Buffer | string) => void;

interface GetRawBody {
  (stream: Readable, options: Options): Promise<Buffer | string>;
  (stream: Readable, options: Options, callback: Callback): void;
}

const HTTP_BAD_REQUEST = 400;
const HTTP_TOO_LARGE = 413;
const HTTP_UNSUPPORTED_MEDIA = 415;

function load(): GetRawBody {
  const module = { exports: {} as unknown };
  // eslint-disable-next-line sonarjs/code-eval -- the adapter's own module source, run to be tested
  runInNewContext(RAW_BODY_SOURCE, { module, Buffer, TextDecoder });
  return module.exports as GetRawBody;
}

function stream(...chunks: string[]): Readable {
  return Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
}

async function failure(work: Promise<unknown>): Promise<RawBodyError> {
  try {
    await work;
  } catch (error) {
    return error as RawBodyError;
  }
  throw new Error('the read did not fail');
}

describe('the vendored raw-body', () => {
  const getRawBody = load();

  it('stands in for the compiled module, however the build names it', () => {
    expect(isStubbedModule('next/dist/compiled/raw-body')).toBe(true);
    expect(isStubbedModule('next-10f02c336b0cb774/dist/compiled/raw-body')).toBe(true);
    expect(isStubbedModule('raw-body')).toBe(false);
    expect(stubSourceFor('next/dist/compiled/raw-body')).toBe(RAW_BODY_SOURCE);
  });

  it('reads the body as a string under an encoding, and as bytes without one', async () => {
    const decoded = await getRawBody(stream('{"a":', '1}'), { encoding: 'utf8', limit: '1mb' });
    const bytes = await getRawBody(stream('raw'), { limit: '1mb' });

    expect(decoded).toBe('{"a":1}');
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.toString()).toBe('raw');
  });

  it('answers the callback form', async () => {
    const body = await new Promise<Buffer | string | undefined>((resolve, reject) => {
      getRawBody(stream('hello'), { encoding: true }, (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      });
    });

    expect(body).toBe('hello');
  });

  it('refuses a body over the limit, as the parser expects', async () => {
    const error = await failure(getRawBody(stream('0123456789'), { encoding: 'utf8', limit: 4 }));

    expect(error.status).toBe(HTTP_TOO_LARGE);
    expect(error.type).toBe('entity.too.large');
  });

  it('refuses a body that is not as long as the request said', async () => {
    const error = await failure(getRawBody(stream('abc'), { encoding: 'utf8', length: '5' }));

    expect(error.status).toBe(HTTP_BAD_REQUEST);
    expect(error.type).toBe('request.size.invalid');
  });

  it('refuses an encoding it cannot decode', async () => {
    const error = await failure(getRawBody(stream('abc'), { encoding: 'no-such-encoding' }));

    expect(error.status).toBe(HTTP_UNSUPPORTED_MEDIA);
    expect(error.type).toBe('encoding.unsupported');
  });
});
