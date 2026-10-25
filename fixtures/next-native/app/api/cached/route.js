import { cacheLife, cacheTag } from 'next/cache';
import { connection } from 'next/server';

async function value() {
  'use cache';
  cacheLife('hours');
  cacheTag('native-value');
  const response = await fetch(`${process.env.UPWIND_NATIVE_CONTROL_ORIGIN}/value`);
  return response.text();
}

export async function GET() {
  await connection();
  return Response.json({ value: await value() });
}
