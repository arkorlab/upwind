/** CI copy only: the fixed upstream addon predates Node 26's V8 API removal. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ORIGINAL = '2436d072feb14ad567e0abfe4309d2a02ac7b837';
const BEFORE = 'context->GetIsolate()';
const AFTER = 'v8::Isolate::GetCurrent()';

function blob(source: Buffer): string {
  // eslint-disable-next-line sonarjs/hashing -- Git blob identity must use Git's SHA-1 format; this is not a signature or credential hash.
  return createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex');
}

export async function prepareNode26Addon(directory: string, version: string): Promise<void> {
  if (version !== '26.13.0') return;
  const file = path.join(directory, 'native-addon/addon.cc');
  const original = await readFile(file);
  assert.equal(blob(original), ORIGINAL, 'Node 26 compatibility requires the fixed upstream addon');
  const source = original.toString('utf8');
  assert.equal(source.split(BEFORE).length, 2, 'The fixed V8 context call must occur once');
  const updated = Buffer.from(source.replace(BEFORE, () => AFTER));
  await writeFile(file, updated);
  console.log(
    JSON.stringify({
      kind: 'native-next-node-api-compatibility',
      profile: 'node26-current-isolate-v1',
      nodeVersion: version,
      file: 'native-addon/addon.cc',
      originalBlob: ORIGINAL,
      compiledSourceBlob: blob(updated),
      before: BEFORE,
      after: AFTER,
    }),
  );
}
