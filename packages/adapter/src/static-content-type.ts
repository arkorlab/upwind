import { readFile } from 'node:fs/promises';

import type { AdapterOutput } from 'next';

import { contentTypeFor } from './blobs.ts';

/**
 * The content type a static file is served with. A metadata file the build prerendered
 * (`/robots.txt`, `/favicon.ico`, `/manifest.webmanifest`) is written as `<route>.body`, a name
 * that says nothing about what it holds. Beside it, `<route>.meta` holds the headers the route
 * answered with, which `next start` serves it under: its `Content-Type` is the file's (`text/plain`
 * for a `robots.txt`, where the name alone says `text/plain; charset=utf-8`). Where the build left no
 * such record, or none that names a type, the type comes from the name it is served under.
 */
export async function staticFileContentType(
  output: Pick<AdapterOutput['STATIC_FILE'], 'filePath' | 'pathname'>,
): Promise<string> {
  if (!output.filePath.endsWith('.body')) {
    return contentTypeFor(output.filePath);
  }
  return (await recordedContentType(output.filePath)) ?? contentTypeFor(output.pathname);
}

/**
 * The `Content-Type` the `.meta` beside a prerendered `.body` records, where it records one: none
 * where there is no `.meta`, or one that is not JSON or names no type. A `.meta` there and unreadable
 * stops the build rather than serving the guess this record replaces.
 */
async function recordedContentType(bodyPath: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(`${bodyPath.slice(0, -'.body'.length)}.meta`, 'utf8');
  } catch (error) {
    // No record beside it is a build that left none; a record that cannot be read is not that.
    if ((error as { readonly code?: unknown }).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  const headers = (parsed(text) as { readonly headers?: unknown } | null | undefined)?.headers;
  if (typeof headers !== 'object' || headers === null) {
    return undefined;
  }
  const type = Object.entries(headers as Readonly<Record<string, unknown>>).find(
    ([name]) => name.toLowerCase() === 'content-type',
  )?.[1];
  return typeof type === 'string' && type !== '' ? type : undefined;
}

/** `text` read as JSON, or `undefined` where it is not JSON. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
