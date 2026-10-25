import { writeFile } from 'node:fs/promises';

import { after } from 'next/server';

export async function POST() {
  after(async () => {
    await fetch(`${process.env.UPWIND_NATIVE_CONTROL_ORIGIN}/after`, { cache: 'no-store' });
    await writeFile(process.env.UPWIND_NATIVE_AFTER_MARKER, 'native-after-completed');
  });
  return Response.json({ accepted: true });
}
