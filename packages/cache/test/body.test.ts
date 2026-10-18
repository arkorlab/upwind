import { MAX_TAG_LENGTH, MAX_TAGS_PER_ENTRY } from '@stayingupwind/core/cache';
import {
  dataSetRequestSchema,
  MAX_DATA_HANDLER_LENGTH,
  MAX_DATA_KEY_LENGTH,
} from '@stayingupwind/host/cache';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CACHE_VARS } from '../src/env.ts';
import { UNCOUNTED_BODY_BYTES } from '../src/gateway/body-room.ts';
import { readJson } from '../src/gateway/body.ts';
import { maxSetBodyBytes } from '../src/gateway/routes/data.ts';

const encoder = new TextEncoder();
const TOO_LARGE = 'the body is too long';
const MAX_BYTES = DEFAULT_CACHE_VARS.MAX_ARTIFACT_BYTES;
const BODY_LIMIT = maxSetBodyBytes(MAX_BYTES);

/** A body read through the gateway's parser, without an authority or storage after it. */
async function read(
  body: string | ReadableStream<Uint8Array>,
  inspect?: (json: unknown) => void,
): Promise<Response> {
  const app = new Hono();
  app.put('/', async (c) => {
    const parsed = await readJson(c, BODY_LIMIT, TOO_LARGE);
    if (parsed instanceof Response) {
      return parsed;
    }
    inspect?.(parsed.json);
    return c.body(null, 204);
  });
  return await app.request('/', { method: 'PUT', body });
}

/**
 * The largest data value, sent in repeated small chunks rather than kept as another whole copy
 * beside the parser's bytes and strings. The metadata puts JSON's punctuation, quotes and escapes
 * inside strings at their bounds: none of those are values for the lexical count to add.
 */
function largestWrite(): ReadableStream<Uint8Array> {
  const escaped = String.raw`\",{}[]`.repeat(MAX_DATA_KEY_LENGTH);
  const request = {
    key: escaped.slice(0, MAX_DATA_KEY_LENGTH),
    entry: {
      kind: 'data:use-cache',
      handler: escaped.slice(0, MAX_DATA_HANDLER_LENGTH),
      tags: Array.from({ length: MAX_TAGS_PER_ENTRY }, () => escaped.slice(0, MAX_TAG_LENGTH)),
      stale: 60,
      timestamp: 0,
      expire: 3600,
      revalidate: 60,
      dependencyCoverage: 'complete',
    },
    valueBase64: '',
  };
  const prefix = encoder.encode(JSON.stringify(request).slice(0, -2));
  const padding = (3 - (MAX_BYTES % 3)) % 3;
  const base64Length = Math.ceil(MAX_BYTES / 3) * 4;
  const chunk = encoder.encode('A'.repeat(64 * 1024));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(prefix);
      let remaining = base64Length - padding;
      while (remaining >= chunk.byteLength) {
        controller.enqueue(chunk);
        remaining -= chunk.byteLength;
      }
      controller.enqueue(chunk.subarray(0, remaining));
      controller.enqueue(encoder.encode(`${'='.repeat(padding)}"}`));
      controller.close();
    },
  });
}

describe('the gateway JSON body', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses a large body of many small objects before parsing any of it', async () => {
    const text = `[${'{},'.repeat(Math.ceil(UNCOUNTED_BODY_BYTES / 3))}{}]`;
    const parse = vi.spyOn(JSON, 'parse');

    const response = await read(text);

    expect(response.status).toBe(400);
    expect(parse).not.toHaveBeenCalledWith(text);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'invalid_request',
        message: `a JSON body past ${UNCOUNTED_BODY_BYTES} bytes may hold at most 16384 values`,
      },
    });
  });

  it('keeps the existing parse path for a body of exactly one mebibyte', async () => {
    const values = `[${'{},'.repeat(10_000)}{}]`;
    const text = values.padEnd(UNCOUNTED_BODY_BYTES, ' ');
    const parse = vi.spyOn(JSON, 'parse');

    const response = await read(text);

    expect(response.status).toBe(204);
    expect(parse).toHaveBeenCalledWith(text);
  });

  it('takes the largest legal base64 value and metadata whose strings contain JSON punctuation', async () => {
    const response = await read(largestWrite(), (json) => {
      const parsed = dataSetRequestSchema.parse(json);

      expect(parsed.valueBase64).toHaveLength(Math.ceil(MAX_BYTES / 3) * 4);
      expect(parsed.key).toHaveLength(MAX_DATA_KEY_LENGTH);
      expect(parsed.entry.tags).toHaveLength(MAX_TAGS_PER_ENTRY);
      expect(parsed.entry.handler).toHaveLength(MAX_DATA_HANDLER_LENGTH);
    });

    expect(response.status).toBe(204);
  });

  it('still refuses malformed JSON after a large body passes the value count', async () => {
    const response = await read(`${' '.repeat(UNCOUNTED_BODY_BYTES)}{`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request', message: 'the body is not JSON' },
    });
  });
});
