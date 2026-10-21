/**
 * A cache host that keeps the data cache in the isolate's memory, for the one thing this fixture
 * asks of it: that a read of an entry is still under way when a second request asks for the same
 * key (`tools/next-matrix/src/use-cache-concurrency.ts`).
 *
 * Every read is told to the runner before it is answered, through the service binding the runner
 * gives the Function (`READS`), and goes on once the runner answers that call. So the runner sees
 * each read begin and decides when it ends: it holds the first request's read until it has seen the
 * second request's read of the same key begin, rather than waiting for a time it hopes is long
 * enough. Each read names the request it is for, by the header the runner sent that request with,
 * which this reads back from the request context the runtime keeps for libraries
 * (`Symbol.for('@vercel/request-context')`). This host is for that runner alone: given no such
 * binding, the Function fails at its first request.
 *
 * And every write is answered as superseded — as if the writer had sent a later write of the key
 * that was kept instead — so the runtime does not remember the value it wrote, and the next read of
 * the key comes here, as one in an isolate that did not write it would. Without that the isolate
 * answers every read after the first from its own memory, at once, and no second request could
 * arrive during one.
 *
 * Nothing else is kept: no tags are recorded and nothing is published, since a route handler that
 * reads one value is all the fixture has.
 */

/** The binding reads are told through, by the name the runner gives it (`READS_BINDING` there). */
const READS = 'UPWIND_MATRIX_READS';
/** The header the runner names each request by (`REQUEST_HEADER` there). */
const REQUEST_HEADER = 'x-next-matrix-request';
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
const values = new Map();
let revision = 0;

function unasked() {
  return Promise.reject(new Error('not asked of this fixture'));
}

/** The request being served, by the name the runner sent it with. */
function requestName() {
  return globalThis[REQUEST_CONTEXT]?.get()?.headers[REQUEST_HEADER];
}

function hostOf(reads) {
  return {
    async getData({ key }) {
      // Answered once the runner lets the read go on: until then, the read is under way.
      const answer = await reads.fetch('http://reads.next-matrix.test/', {
        method: 'POST',
        body: JSON.stringify({ key, request: requestName() }),
      });
      if (!answer.ok) {
        throw new Error(`the runner answered a read with ${answer.status}`);
      }
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
}

export function createCacheHost({ env }) {
  const reads = env?.[READS];
  if (reads === undefined) {
    throw new Error(`no ${READS} binding: this cache host is run by tools/next-matrix, which binds it`);
  }
  return { host: hostOf(reads), scopeId: 'next-use-cache-concurrency', clockOf: () => undefined };
}
