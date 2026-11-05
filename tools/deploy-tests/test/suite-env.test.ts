import { describe, expect, it } from 'vitest';

import { suiteVariables } from '../src/suite-env.ts';

describe("a suite's variables", () => {
  it('are what the hook was given beyond the harness', () => {
    const harness = new Map([
      ['HOME', '/home/runner'],
      ['STARTED_WITH', 'a'],
    ]);

    expect(
      suiteVariables({ HOME: '/home/runner', STARTED_WITH: 'b', SUITE_ONLY: '1' }, harness),
    ).toStrictEqual({ STARTED_WITH: 'b', SUITE_ONLY: '1' });
  });

  it("leave out what Next.js's harness and Jest set for themselves", () => {
    expect(
      suiteVariables(
        {
          NEXT_TEST_MODE: 'deploy',
          NEXT_TEST_DIR: '/work/next',
          JEST_WORKER_ID: '1',
          PWD: '/work',
        },
        new Map(),
      ),
    ).toStrictEqual({});
  });

  it("leave out this tool's own, its credentials among them", () => {
    expect(
      suiteVariables({ ARKOR_API_TOKEN: 'token', ADAPTER_TEST_PROJECT_IDS: 'a,b' }, new Map()),
    ).toStrictEqual({});
  });

  it('keep the tag prefix a suite sets, which its Function reads at request time', () => {
    expect(
      suiteVariables(
        { NEXT_TEST_CACHE_TAG_PREFIX: 'resume-data-cache:default', NEXT_TEST_MODE: 'deploy' },
        new Map(),
      ),
    ).toStrictEqual({ NEXT_TEST_CACHE_TAG_PREFIX: 'resume-data-cache:default' });
  });
});
