import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NativeAuthority } from '../../src/native/authority.ts';
import * as maintenance from '../../src/native/maintenance.ts';
import * as state from '../../src/scope/state.ts';

describe('native maintenance', () => {
  let authority: NativeAuthority | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await authority?.close();
    authority = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
    directory = undefined;
  });

  it('retries maintenance after a synchronous scope read fails before its first await', async () => {
    vi.useFakeTimers();
    directory = await mkdtemp(path.join(os.tmpdir(), 'upwind-native-maintenance-'));
    authority = await NativeAuthority.open({
      directory,
      scopeId: 'native-maintenance',
      buildId: 'build-test',
    });
    const read = vi.spyOn(state, 'readScope').mockImplementationOnce(() => {
      throw new Error('transient SQLite scope read failure');
    });
    const maintain = vi.spyOn(maintenance, 'maintainNativeCache');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {
      // The expected transient failure is asserted below.
    });

    await vi.advanceTimersByTimeAsync(1);

    expect(read).toHaveBeenCalledTimes(1);
    expect(maintain).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('transient SQLite scope read failure'),
    );

    await vi.advanceTimersByTimeAsync(1000);

    expect(maintain).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
