import { connection } from 'next/server';

/** A handler that fails before it answers, on every request: what the runtime turns into a 500. */
export async function GET(): Promise<never> {
  await connection();
  throw new Error('boom');
}
