import { connection } from 'next/server';

/**
 * A cached `fetch` with a lifetime: what the `fetch-cache-wait-until` patch rewrites is the
 * registration of the write that follows it, in `patch-fetch`. `connection()` first, so the
 * build never runs this and the matrix needs no network.
 */
export async function GET() {
  await connection();
  const response = await fetch('https://example.com/', { next: { revalidate: 5 } });
  return Response.json({ status: response.status });
}
