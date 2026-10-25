/* eslint-disable @typescript-eslint/require-await -- Next.js handler fixtures retain their async contract when completing synchronously. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { describe, it } from 'vitest';

import { changesSomething, type InvokeInput } from '../../src/invocation.ts';
import { closeNodeBridge, invokeNodeHandler } from '../../src/native/entry.ts';

describe('native invocation contract', () => {
  it('preserves the existing safe-method classification', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'TRACE']) {
      assert.equal(changesSomething(method), false);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(changesSomething(method), true);
    }
  });

  it('exports an invocation entry compatible with the existing call sites', async () => {
    const invoke: (input: InvokeInput) => Promise<Response> = invokeNodeHandler;
    try {
      const response = await invoke({
        handler: async (_req, res) => {
          res.end('native');
        },
        request: new Request('http://app.test/'),
        requestMeta: {},
        waitUntil: () => {
          /* No host task/reporting action is needed by this fixture. */
        },
      });
      assert.equal(await response.text(), 'native');
    } finally {
      assert.equal(await closeNodeBridge(), true);
    }
  });

  it('keeps Workers exports and publishes native transport as opt-in subpaths', async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The URL names this package's own manifest.
    const serialized = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
    const manifest = JSON.parse(serialized) as { exports: Record<string, string> };
    assert.equal(manifest.exports['./function'], './src/function.ts');
    assert.equal(manifest.exports['./native'], './src/native/index.ts');
  });

  it('normalizes response headers when Connection is absent or has empty options', async () => {
    const { responseHeaders } = await import('../../src/native/headers.ts');
    const plain = responseHeaders(['Content-Type', 'text/plain']);
    assert.equal(plain.get('content-type'), 'text/plain');
    const empty = responseHeaders(['Connection', ', close, ,', 'X-Kept', 'yes']);
    assert.equal(empty.get('connection'), null);
    assert.equal(empty.get('x-kept'), 'yes');
  });

  it('maps a closing singleton to a non-cacheable admission response', async () => {
    await closeNodeBridge();
    const response = await invokeNodeHandler({
      handler: async () => assert.fail('a closed bridge must not invoke the handler'),
      request: new Request('https://app.test/'),
      requestMeta: {},
      waitUntil: () => {
        /* No host task/reporting action is needed by this fixture. */
      },
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(await response.text(), 'Service Unavailable');
  });
});
