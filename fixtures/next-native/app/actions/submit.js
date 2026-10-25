'use server';

import { writeFile } from 'node:fs/promises';

import { redirect } from 'next/navigation';

export async function submit(form) {
  await writeFile(process.env.UPWIND_NATIVE_ACTION_MARKER, String(form.get('value')));
  redirect('/action-done');
}
