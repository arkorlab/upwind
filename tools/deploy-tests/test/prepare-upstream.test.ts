import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Script } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { prepareFormPrefetch } from '../src/prepare-upstream.ts';

// First case from Next.js v16.4.3, test/e2e/next-form/default/shared-tests.util.ts (MIT).
const SOURCE = `    it(
      'should soft-navigate on submit' +
        (isAppDir ? ' and show the prefetched loading state' : ''),
      async () => {
        const session = await next.browser(pathPrefix + '/forms/basic')
        const navigationTracker = await trackMpaNavs(session)

        const searchInput = await session.elementByCss('input[name="query"]')
        await searchInput.fill('my search')

        const submitButton = await session.elementByCss('[type="submit"]')
        await submitButton.click()

        if (isAppDir) {
          // we should have prefetched a loading state, so it should be displayed
          await session.waitForElementByCss('#loading')
        }

        const result = await session
          .waitForElementByCss('#search-results')
          .text()
        expect(result).toMatch(/query: "my search"/)

        expect(await navigationTracker.didMpaNavigate()).toBe(false)
      }
    )

    it('should soft-navigate to the formAction url of the submitter', async () => {})
`;

function responseOf(url: string, prefetch: string | undefined) {
  return {
    url: () => url,
    request: () => ({ headers: () => ({ 'next-router-prefetch': prefetch }) }),
  };
}

describe('upstream Form prefetch preparation', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('retains every upstream assertion and every following test', () => {
    const prepared = prepareFormPrefetch(SOURCE);
    const originalAssertions = SOURCE.slice(SOURCE.indexOf('        if (isAppDir)'));

    expect(prepared.endsWith(originalAssertions)).toBe(true);
    expect(prepared).toContain("response.request().headers()['next-router-prefetch'] === '1'");
    expect(prepared).toContain("new URL(response.url()).pathname === '/search'");
  });

  it.each([
    SOURCE.replace('should soft-navigate on submit', 'renamed upstream case'),
    SOURCE.replace("pathPrefix + '/forms/basic'", "'/renamed-form'"),
    SOURCE.replace("await session.waitForElementByCss('#loading')", 'await changedAssertion()'),
    SOURCE.replace(
      "    it('should soft-navigate to the formAction",
      "    it('renamed following case",
    ),
  ])('rejects unfamiliar source instead of silently changing it', (source) => {
    expect(() => prepareFormPrefetch(source)).toThrow('unrecognized upstream Form');
  });

  it('waits for a real prefetch body and network idle before submitting', async () => {
    const trace: string[] = [];
    const responseReady = Promise.withResolvers<{
      ok(): boolean;
      finished(): Promise<null>;
    }>();
    const bodyReady = Promise.withResolvers<null>();
    const idleReady = Promise.withResolvers<undefined>();
    const callbacks: (() => Promise<void>)[] = [];
    const session = {
      elementByCss: () => {
        return {
          fill: () => {
            trace.push('fill');
          },
          click: () => {
            trace.push('submit');
          },
        };
      },
      waitForElementByCss: () => ({ text: () => 'query: "my search"' }),
      waitForIdleNetwork: () => {
        trace.push('idle');
        return idleReady.promise;
      },
    };
    const page = {
      waitForResponse(predicate: (value: ReturnType<typeof responseOf>) => boolean) {
        expect(predicate(responseOf('https://fixture.test/search?_rsc=abc', '1'))).toBe(true);
        expect(predicate(responseOf('https://fixture.test/search?query=a', undefined))).toBe(false);
        expect(predicate(responseOf('https://fixture.test/other', '1'))).toBe(false);

        trace.push('observe');
        return responseReady.promise;
      },
    };
    const next = {
      browser(_url: string, options: { beforePageLoad(value: typeof page): void }) {
        options.beforePageLoad(page);
        trace.push('navigate');
        return Promise.resolve(session);
      },
    };
    // Execute this trusted upstream fixture after transformation, with a browser that independently
    // controls response headers, body completion, and network idle. No fetched source is evaluated.
    // eslint-disable-next-line sonarjs/code-eval -- only the trusted local fixture above is executed, with explicit browser doubles.
    new Script(prepareFormPrefetch(SOURCE)).runInNewContext({
      it: (_title: string, callback: () => Promise<void>) => {
        callbacks.push(callback);
      },
      isAppDir: true,
      isNextDev: false,
      pathPrefix: '',
      next,
      trackMpaNavs: () => ({ didMpaNavigate: () => false }),
      expect,
      URL,
    });
    const run = callbacks[0]?.();

    expect(run).toBeDefined();

    await vi.waitFor(() => {
      expect(trace).toContain('fill');
    });

    expect(trace).toStrictEqual(['observe', 'navigate', 'fill']);

    responseReady.resolve({
      ok: () => true,
      finished: () => {
        trace.push('body');
        return bodyReady.promise;
      },
    });
    await vi.waitFor(() => {
      expect(trace).toContain('body');
    });

    expect(trace).not.toContain('submit');

    bodyReady.resolve(null);
    await vi.waitFor(() => {
      expect(trace).toContain('idle');
    });

    expect(trace).not.toContain('submit');

    idleReady.resolve(undefined);
    await run;

    expect(trace).toStrictEqual(['observe', 'navigate', 'fill', 'body', 'idle', 'submit']);
  });

  it('leaves an unfamiliar checkout unchanged when preparation fails', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'upwind-form-test-'));
    dirs.push(dir);
    const file = path.join(dir, 'test/e2e/next-form/default/shared-tests.util.ts');
    mkdirSync(path.dirname(file), { recursive: true });
    const source = SOURCE.replace('should soft-navigate on submit', 'unknown upstream case');
    writeFileSync(file, source);
    const result = spawnSync(process.execPath, [
      path.resolve(import.meta.dirname, '../src/prepare-upstream.ts'),
      dir,
    ]);

    expect(result.status).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(source);
  });
});
