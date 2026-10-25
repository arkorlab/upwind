import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import sharp from 'sharp';
import { connection } from 'next/server';

const run = promisify(execFile);

export async function GET() {
  await connection();
  const file = await readFile(new URL('./data.txt', import.meta.url), 'utf8');
  const child = await run(process.execPath, ['-e', 'process.stdout.write("native-child")']);
  const image = await sharp({ create: { width: 1, height: 1, channels: 4, background: 'red' } }).png().toBuffer();
  return Response.json({ file: file.trim(), child: child.stdout, png: image.subarray(0, 8).toString('hex') });
}
