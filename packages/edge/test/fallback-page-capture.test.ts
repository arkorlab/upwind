import { kvGenerationKey } from '@stayingupwind/core/cache';
import { waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { claimBackgroundRecord } from '../src/cache/background-record-budget.ts';
import {
  capturePairedPageData,
  refreshMissingPairedPage,
} from '../src/handlers/static-page-capture.ts';
import type { StaticPageInput } from '../src/handlers/static-page.ts';
import {
  FALLBACK_ROUTE,
  FALLBACK_SCOPE,
  fallbackEdgeFixture,
  type FallbackEdgeFixture,
} from './fallback-page-fixture.ts';

type Member = Awaited<ReturnType<FallbackEdgeFixture['runtimeMember']>>;
const PRIVATE_BODY = '{"private":"complete origin JSON"}';
const FOREGROUND_MS = 10_000;

function captureInput(test: FallbackEdgeFixture, member: Member): StaticPageInput {
  const pathname = member.pack.header.pathname;
  const dataPathname = `/_next/data/${test.native.bundle.buildId}${pathname}.json`;
  const request = new Request(`https://site.example${dataPathname}`);
  return {
    request,
    url: new URL(request.url),
    edge: test.edge,
    manifest: test.manifest,
    entry: {
      staticPagePrivacy: 3,
      entryId: member.entryId,
      route: FALLBACK_ROUTE,
      pathname,
      parameters: { slug: pathname.split('/').at(-1)! },
      dataPathname,
    },
    classifiedHeaders: request.headers,
    passthrough: test.fallback,
  };
}

function privateResponses(test: FallbackEdgeFixture): void {
  // eslint-disable-next-line vitest/prefer-mock-promise-shorthand -- Each invocation needs an unread response body.
  test.dispatch.mockImplementation(() => {
    return Promise.resolve(
      new Response(PRIVATE_BODY, { headers: { 'content-type': 'application/json' } }),
    );
  });
}

describe('foreground paired Pages record verification', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('allows a valid authoritative pair to arrive after the background one-second window', async () => {
    const test = await fallbackEdgeFixture();
    const member = await test.runtimeMember();
    const pending = Promise.withResolvers<ArrayBuffer | undefined>();
    const entered = Promise.withResolvers<undefined>();

    privateResponses(test);

    test.currentRecord.mockImplementationOnce(() => {
      entered.resolve(undefined);
      return pending.promise;
    });

    vi.useFakeTimers();
    const capturing = capturePairedPageData(captureInput(test, member));
    let completed = false;
    const tracked = (async () => {
      const result = await capturing;
      completed = true;
      return result;
    })();

    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(1001);

      expect(completed).toBe(false);

      pending.resolve(member.bytes.buffer as ArrayBuffer);

      const result = await tracked;

      expect(result.decision?.pack.header.generationId).toBe(member.pack.header.generationId);
      expect(result.authorityReads).toBe(1);
      expect(test.currentRecord).toHaveBeenCalledWith(FALLBACK_SCOPE, member.entryId, 0);
      await expect(result.response.text()).resolves.toBe(PRIVATE_BODY);
    } finally {
      pending.resolve(undefined);
      await tracked;
      await waitOnExecutionContext(test.edge.ctx);
    }
  });

  it('verifies foreground publication while this member and another key occupy background slots', async () => {
    const test = await fallbackEdgeFixture();
    const member = await test.runtimeMember();
    const pending = Promise.withResolvers<ArrayBuffer | undefined>();
    const entered = Promise.withResolvers<undefined>();
    const input = captureInput(test, member);

    privateResponses(test);

    test.currentRecord.mockImplementationOnce(() => {
      entered.resolve(undefined);
      return pending.promise;
    });

    test.currentRecord.mockResolvedValueOnce(member.bytes.buffer as ArrayBuffer);

    refreshMissingPairedPage(input, test.edge.policy.runtimeCache!);
    const releaseOther = claimBackgroundRecord(test.edge.runtime, 'another-background-key');

    try {
      await entered.promise;

      const result = await capturePairedPageData(input);

      expect(releaseOther).toBeTypeOf('function');
      expect(test.currentRecord).toHaveBeenCalledTimes(2);
      expect(result.authorityReads).toBe(1);
      expect(result.decision?.pack.header.generationId).toBe(member.pack.header.generationId);
      await expect(result.response.text()).resolves.toBe(PRIVATE_BODY);
    } finally {
      releaseOther?.();
      pending.resolve(undefined);
      await waitOnExecutionContext(test.edge.ctx);
    }
  });

  it('bounds foreground authority reads across two distinct members', async () => {
    const test = await fallbackEdgeFixture();
    const members = await Promise.all([
      test.runtimeMember('/fallback-true/second'),
      test.runtimeMember('/fallback-true/third'),
      test.runtimeMember('/fallback-true/fourth'),
    ]);
    const pending = Promise.withResolvers<ArrayBuffer | undefined>();
    const entered = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()];

    privateResponses(test);
    for (const gate of entered) {
      test.currentRecord.mockImplementationOnce(() => {
        gate.resolve(undefined);
        return pending.promise;
      });
    }
    const first = capturePairedPageData(captureInput(test, members[0]));
    const second = capturePairedPageData(captureInput(test, members[1]));

    try {
      await Promise.all(entered.map((gate) => gate.promise));

      const third = await capturePairedPageData(captureInput(test, members[2]));

      expect(test.currentRecord).toHaveBeenCalledTimes(2);
      expect(third.authorityReads).toBe(0);
      expect(third.decision).toBeUndefined();
      await expect(third.response.text()).resolves.toBe(PRIVATE_BODY);
    } finally {
      pending.resolve(undefined);
      await Promise.all([first, second]);
      await waitOnExecutionContext(test.edge.ctx);
    }
  });

  it('keeps the foreground member slot until a timed-out RPC settles and rejects its late bytes', async () => {
    const test = await fallbackEdgeFixture();
    const member = await test.runtimeMember();
    const pending = Promise.withResolvers<ArrayBuffer | undefined>();
    const entered = Promise.withResolvers<undefined>();
    const input = captureInput(test, member);

    privateResponses(test);

    test.currentRecord.mockImplementationOnce(() => {
      entered.resolve(undefined);
      return pending.promise;
    });

    vi.useFakeTimers();
    const capturing = capturePairedPageData(input);

    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(FOREGROUND_MS + 1);

      const expired = await capturing;
      const refused = await capturePairedPageData(input);

      expect(expired.decision).toBeUndefined();
      await expect(expired.response.text()).resolves.toBe(PRIVATE_BODY);
      expect(refused.authorityReads).toBe(0);
      expect(test.currentRecord).toHaveBeenCalledTimes(1);

      pending.resolve(member.bytes.buffer as ArrayBuffer);
      await waitOnExecutionContext(test.edge.ctx);

      expect(test.edge.runtime.memory.generations.get(member.key)).toBeUndefined();
    } finally {
      pending.resolve(undefined);
      await capturing;
      await waitOnExecutionContext(test.edge.ctx);
    }
  });

  it('releases a settled foreground slot for a subsequent proof without borrowing the older read', async () => {
    const test = await fallbackEdgeFixture();
    const member = await test.runtimeMember();
    const input = captureInput(test, member);

    privateResponses(test);

    test.currentRecord.mockResolvedValueOnce(undefined);

    test.currentRecord.mockResolvedValueOnce(member.bytes.buffer as ArrayBuffer);

    const first = await capturePairedPageData(input);
    const second = await capturePairedPageData(input);

    expect(first.decision).toBeUndefined();
    expect(second.decision?.pack.header.generationId).toBe(member.pack.header.generationId);
    expect(test.currentRecord).toHaveBeenCalledTimes(2);
    expect(kvGenerationKey(FALLBACK_SCOPE, member.entryId)).toBe(member.key);

    await waitOnExecutionContext(test.edge.ctx);
  });
});
