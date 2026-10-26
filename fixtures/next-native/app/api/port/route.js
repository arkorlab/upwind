import { connection } from 'next/server';

export async function GET() {
  await connection();
  return Response.json({ port: process.env.PORT ?? null });
}
