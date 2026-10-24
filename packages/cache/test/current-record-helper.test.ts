import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readCurrentRecord } from '../src/scope/commit-record.ts';
import type { BlobStore } from '../src/scope/io.ts';
import { PROJECTION_MEMORY_BYTES, withProjectionMemory } from '../src/scope/projection-memory.ts';

const built = vi.hoisted(() => {
  return {
    bytes: new Uint8Array([1, 2, 3]),
    length: 3,
    read: vi.fn<() => Promise<void>>(),
  };
});

vi.mock(import('../src/scope/records.ts'), async (original) => {
  return {
    ...(await original()),
    recordBytesOf: () => built.length,
    generationRecordBytes: async () => {
      await built.read();
      return built.bytes;
    },
  };
});

/** Only the three read queries the authority helper uses; every other statement is refused. */
function stored() {
  const scope = { scope_id: 'scope', status: 'active' };
  const entry = {
    entry_id: 'entry',
    kind: 'app-page',
    publication: 'published',
    current_generation_id: 'generation',
    record_revision: 2,
    kv_revision: 1,
  };
  const generation = { generation_id: 'generation' };
  const sql = {
    exec: vi.fn((query: string, id?: string) => {
      let rows: Record<string, unknown>[];
      switch (query) {
        case 'SELECT * FROM scope LIMIT 1': {
          rows = [scope];
          break;
        }
        case 'SELECT * FROM entries WHERE entry_id = ?': {
          rows = id === entry.entry_id ? [entry] : [];
          break;
        }
        case 'SELECT * FROM generations WHERE generation_id = ?': {
          rows = id === generation.generation_id ? [generation] : [];
          break;
        }
        default: {
          throw new Error(`not a read query: ${query}`);
        }
      }
      return { toArray: () => rows };
    }),
  };
  // The helper only reads through exec/toArray; no other SQL operation is implemented here.
  const deps = { scopeId: 'scope', sql: sql as unknown as SqlStorage, blobs: {} as BlobStore };
  return { deps, scope, entry, generation, sql };
}

describe('a current authority record read', () => {
  beforeEach(() => {
    built.length = built.bytes.byteLength;
    built.read.mockReset();
    built.read.mockResolvedValue(undefined);
  });

  it('returns a newer record without requiring its KV projection or writing SQL', async () => {
    const state = stored();

    await expect(readCurrentRecord(state.deps, 'entry', 1)).resolves.toBe(built.bytes.buffer);
    expect(state.entry.kv_revision).toBeLessThan(state.entry.record_revision);
    expect(state.sql.exec.mock.calls.every(([query]) => query.startsWith('SELECT '))).toBe(true);
  });

  it('does not build an unknown or unchanged entry', async () => {
    const state = stored();

    await expect(readCurrentRecord(state.deps, 'unknown', 0)).resolves.toBeUndefined();
    await expect(readCurrentRecord(state.deps, 'entry', 2)).resolves.toBeUndefined();
    await expect(readCurrentRecord(state.deps, 'entry', 3)).resolves.toBeUndefined();
    expect(built.read).not.toHaveBeenCalled();
  });

  it.each(['revision', 'generation', 'retirement'] as const)(
    'returns none if %s changes while the artifacts are read',
    async (change) => {
      const state = stored();
      built.read.mockImplementation(() => {
        if (change === 'revision') state.entry.record_revision += 1;
        else if (change === 'generation') state.entry.current_generation_id = 'later';
        else state.scope.status = 'retired';
        return Promise.resolve();
      });

      await expect(readCurrentRecord(state.deps, 'entry', 1)).resolves.toBeUndefined();
    },
  );

  it('returns none before reading a retired or differently named scope', async () => {
    const state = stored();
    state.scope.status = 'retired';

    await expect(readCurrentRecord(state.deps, 'entry', 0)).resolves.toBeUndefined();

    state.scope.status = 'active';
    state.scope.scope_id = 'another';

    await expect(readCurrentRecord(state.deps, 'entry', 0)).resolves.toBeUndefined();
    expect(built.read).not.toHaveBeenCalled();
  });

  it('returns none for a record over four MiB without reading its artifacts', async () => {
    built.length = 4 * 1024 * 1024 + 1;

    await expect(readCurrentRecord(stored().deps, 'entry', 0)).resolves.toBeUndefined();
    expect(built.read).not.toHaveBeenCalled();
  });

  it('returns none instead of waiting for projection memory', async () => {
    const release = Promise.withResolvers<undefined>();
    const held = withProjectionMemory(PROJECTION_MEMORY_BYTES, () => release.promise);
    try {
      await expect(readCurrentRecord(stored().deps, 'entry', 0)).resolves.toBeUndefined();
      expect(built.read).not.toHaveBeenCalled();
    } finally {
      release.resolve(undefined);
      await held;
    }

    await expect(readCurrentRecord(stored().deps, 'entry', 0)).resolves.toBe(built.bytes.buffer);
  });
});
