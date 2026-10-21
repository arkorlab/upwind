import { connection } from 'next/server';

/**
 * A public `"use cache"` function, and so one whose entry every request for this route reads
 * under the same key. What it returns is when it was filled, so that an answer read from the entry
 * can be told apart from one filled again.
 */
async function shared() {
  'use cache';
  return { filledAt: Date.now() };
}

/** `connection()` first: the build prerenders nothing here, and every request reads the entry. */
export async function GET() {
  await connection();
  return Response.json(await shared());
}
