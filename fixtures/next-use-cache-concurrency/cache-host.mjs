/**
 * A cache host that keeps the data cache in the isolate's memory, for the one thing this fixture
 * asks of it: that a read of an entry is still under way when a second request asks for the same
 * key (`tools/next-matrix/src/use-cache-concurrency.ts`).
 *
 * Every read takes `READ_MS`, as a read of storage somewhere else would. And every write is answered
 * as superseded — as if the writer had sent a later write of the key that was kept instead — so the
 * runtime does not remember the value it wrote, and the next read of the key comes here, as one in
 * an isolate that did not write it would. Without that the isolate answers every read after the
 * first from its own memory, at once, and no second request could arrive during one.
 *
 * Nothing else is kept: no tags are recorded and nothing is published, since a route handler that
 * reads one value is all the fixture has.
 */

const READ_MS = 1500;
const values = new Map();
let revision = 0;

function later(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function unasked() {
  return Promise.reject(new Error('not asked of this fixture'));
}

const host = {
  async getData({ key }) {
    await later(READ_MS);
    const held = values.get(key);
    if (held === undefined) {
      return undefined;
    }
    return {
      entryId: key,
      generationId: String(held.revision),
      dependencyRevision: held.revision,
      entry: held.entry,
      value: { kind: 'inline', base64: held.base64 },
    };
  },
  async setData({ key, entry, valueBase64 }) {
    revision += 1;
    values.set(key, { entry, base64: valueBase64, revision });
    return { entryId: key, generationId: String(revision), revision, superseded: true };
  },
  getTags: async () => ({ tags: [] }),
  tagsDelta: async () => ({ revision, truncated: false, tags: [] }),
  invalidate: async () => ({ invalidations: [] }),
  readRecord: async () => undefined,
  readArtifact: async () => undefined,
  startAttempt: unasked,
  uploadArtifact: unasked,
  heartbeat: unasked,
  commit: unasked,
  fail: unasked,
};

export function createCacheHost() {
  return { host, scopeId: 'next-use-cache-concurrency', clockOf: () => undefined };
}
