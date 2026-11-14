import { describe, expect, it } from 'vitest';

import {
  deploymentBundleSchema,
  MIN_WORKER_COMPATIBILITY_DATE,
  WORKER_COMPATIBILITY_FLAGS,
  workerCompatibilityDateSchema,
  workerCompatibilityFlagSchema,
  workerFunctionSchema,
} from '../src/bundle/index.ts';
import { fixtureBundle } from './fixtures/bundle.ts';

describe('worker Function compatibility contract', () => {
  it('accepts every allowlisted compatibility flag individually and in combinations', () => {
    const app = fixtureBundle().functions.app;

    for (const flag of WORKER_COMPATIBILITY_FLAGS) {
      expect(workerCompatibilityFlagSchema.parse(flag)).toBe(flag);
      expect(workerFunctionSchema.safeParse({ ...app, compatibilityFlags: [flag] }).success).toBe(
        true,
      );
    }

    expect(
      workerFunctionSchema.safeParse({
        ...app,
        compatibilityFlags: [
          'nodejs_compat',
          'nodejs_als',
          'nodejs_compat_populate_process_env',
          'global_fetch_strictly_public',
          'enable_nodejs_http_modules',
          'enable_nodejs_http_server_modules',
        ],
      }).success,
    ).toBe(true);
    expect(workerFunctionSchema.safeParse({ ...app, compatibilityFlags: [] }).success).toBe(true);
  });

  it('rejects dangerous and unknown compatibility flags in worker functions and bundles', () => {
    const bundle = fixtureBundle();
    const app = bundle.functions.app;

    for (const disallowed of [
      'disable_global_fetch_strictly_public',
      'allow_custom_ports',
      'fetcher_no_get_put_delete_body',
      'experimental',
      'disallow_importable_env',
      'no_nodejs_compat',
      'unknown_compatibility_flag',
      '',
    ]) {
      expect(workerCompatibilityFlagSchema.safeParse(disallowed).success).toBe(false);
      expect(
        workerFunctionSchema.safeParse({
          ...app,
          compatibilityFlags: ['nodejs_compat', disallowed],
        }).success,
      ).toBe(false);
      expect(
        deploymentBundleSchema.safeParse({
          ...bundle,
          functions: {
            ...bundle.functions,
            app: { ...app, compatibilityFlags: [disallowed] },
          },
        }).success,
      ).toBe(false);
    }
  });

  it('accepts real calendar compatibility dates on or after the minimum floor', () => {
    const app = fixtureBundle().functions.app;

    for (const date of [
      MIN_WORKER_COMPATIBILITY_DATE,
      '2024-09-23',
      '2025-01-01',
      '2025-09-02',
      '2026-04-27',
      '2026-09-15',
      '2028-02-29',
    ]) {
      expect(workerCompatibilityDateSchema.parse(date)).toBe(date);
      expect(workerFunctionSchema.safeParse({ ...app, compatibilityDate: date }).success).toBe(
        true,
      );
    }
  });

  it('rejects compatibility dates before the minimum floor or outside the Gregorian calendar', () => {
    const bundle = fixtureBundle();
    const app = bundle.functions.app;

    for (const invalidDate of [
      '2020-01-01',
      '2024-02-29',
      '2024-09-22',
      '9999-99-99',
      '2026-00-01',
      '2026-13-01',
      '2026-01-00',
      '2026-02-29',
      '2026-04-31',
      '2100-02-29',
      '2026-9-15',
      '2026-09-15T00:00:00Z',
      'not-a-date',
    ]) {
      expect(workerCompatibilityDateSchema.safeParse(invalidDate).success).toBe(false);
      expect(
        workerFunctionSchema.safeParse({ ...app, compatibilityDate: invalidDate }).success,
      ).toBe(false);
      expect(
        deploymentBundleSchema.safeParse({
          ...bundle,
          functions: {
            ...bundle.functions,
            app: { ...app, compatibilityDate: invalidDate },
          },
        }).success,
      ).toBe(false);
    }
  });
});
