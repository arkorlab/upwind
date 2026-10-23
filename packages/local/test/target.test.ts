import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agentTarget } from '../src/target.ts';
import { METADATA_HEADER } from '../src/workers/protocol.ts';

/** What the agent was sent: each write's route and headers, as a stand-in for it records them. */
const received: { url: string; headers: IncomingHttpHeaders }[] = [];
const agent = createServer((request, response) => {
  received.push({ url: request.url ?? '', headers: request.headers });
  request.resume();
  request.on('end', () => {
    response.statusCode = 204;
    response.end();
  });
});

describe('the target a build is deployed to on a stack', () => {
  const state: { url?: URL } = {};

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      agent.listen(0, '127.0.0.1', resolve);
    });
    state.url = new URL(`http://127.0.0.1:${(agent.address() as AddressInfo).port}`);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      agent.close(() => {
        resolve();
      });
    });
  });

  it('sends a write’s metadata in a header any pathname fits in', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'upwind-local-'));
    mkdirSync(path.join(dir, 'blobs'));
    const target = agentTarget(state.url ?? new URL('http://invalid'), dir);
    const metadata = { sourcePath: '/日本/ページ' };

    await target.bucket.put('artifacts/shell', 'bytes', {
      contentType: 'text/html; charset=utf-8',
      customMetadata: metadata,
    });
    await target.edgeState.put('shell:key', 'bytes', metadata);

    const sent = received.map((write) => String(write.headers[METADATA_HEADER]));
    const decoded = sent.map((header): unknown => JSON.parse(decodeURIComponent(header)));

    expect(sent.every((header) => /^\p{ASCII}+$/u.test(header))).toBe(true);
    expect(decoded).toStrictEqual([metadata, metadata]);
    await expect(target.blobs.read('0'.repeat(64))).resolves.toBeUndefined();
  });
});
