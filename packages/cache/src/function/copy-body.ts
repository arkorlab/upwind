/** The body an artifact's copy is kept with in its data center's Cache API (`artifacts.ts`). */

const KIB = 1024;
/**
 * How much of a copy is handed to the Cache API at a time. A copy's body is the bytes the read
 * answered with, read in slices of them (`sliced`): `new Response` given the bytes themselves
 * takes a copy of them, and a render that misses several large data values at once would hold each
 * of them twice while their copies are written — three of 25 MiB is past a Function's 128 MB.
 */
const COPY_SLICE_KIB = 64;
const COPY_SLICE_BYTES = COPY_SLICE_KIB * KIB;

/** The bytes as a body read from them, a slice at a time, rather than from a copy of them. */
function sliced(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + COPY_SLICE_BYTES, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

/** A stream that says how long its body is, as the runtime's `FixedLengthStream` does. */
type FixedLength = new (length: number) => TransformStream<Uint8Array, Uint8Array>;

/**
 * The runtime's `FixedLengthStream`, where it has one: a Worker on Cloudflare does, and Node.js,
 * where the suites run the runtime, does not — nor does it keep copies (`cacheStorage`).
 */
function fixedLengthStream(): FixedLength | undefined {
  return Reflect.get(globalThis, 'FixedLengthStream') as FixedLength | undefined;
}

/**
 * Put the bytes in the copies' cache under `key`, a slice at a time (`sliced`), through a stream of
 * the length they are: the runtime sends the length a body has, not one set on its headers by
 * hand, and a copy kept with its length says it when it is read, which is the room its read takes
 * (`ArtifactRoom`). A pipe a put that failed left unread is called off, rather than left holding
 * the bytes.
 */
export async function putCopy(
  cache: Cache,
  key: string,
  bytes: Uint8Array,
  headers: Readonly<Record<string, string>>,
): Promise<void> {
  const Stated = fixedLengthStream();
  if (Stated === undefined) {
    await cache.put(key, new Response(sliced(bytes), { headers }));
    return;
  }
  const body = new Stated(bytes.byteLength);
  const fed = new AbortController();
  void sliced(bytes)
    .pipeTo(body.writable, { signal: fed.signal })
    .catch(() => {
      // A put that failed says why where it fails; the pipe it stopped says nothing more.
    });
  try {
    await cache.put(key, new Response(body.readable, { headers }));
  } catch (error) {
    fed.abort(error);
    throw error;
  }
}
