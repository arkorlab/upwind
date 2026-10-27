import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { WorkerFunctionSpec } from '@stayingupwind/core/bundle';

const DECLARATION = /\.d\.[cm]?ts$/u;
export interface DeclarationSource {
  name: string;
  sha256: string;
  byteLength: number;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right);
}

/** Independent source-to-emitted inventory: an unreadable trace or dropped/extra data fails CI. */
export async function checkedDeclarationSources(
  app: string,
  spec: Pick<WorkerFunctionSpec, 'modules'>,
): Promise<DeclarationSource[]> {
  const traceFile = path.join(app, '.next', 'server', 'app', 'route.js.nft.json');
  const trace: unknown = JSON.parse(await readFile(traceFile, 'utf8'));
  assert.ok(
    typeof trace === 'object' && trace !== null && 'files' in trace && strings(trace.files),
    'The route trace must contain a readable file inventory',
  );
  const realApp = await realpath(app);
  const sources = new Map<string, DeclarationSource>();
  for (const file of trace.files) {
    if (!DECLARATION.test(file)) continue;
    const source = path.resolve(path.dirname(traceFile), file);
    assert.ok(
      within(app, source) && within(realApp, await realpath(source)),
      'Traced declaration must belong to the fixture',
    );
    const name = path.relative(app, source).split(path.sep).join('/');
    const bytes = await readFile(source);
    const ref = {
      name,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.byteLength,
    };
    const previous = sources.get(name);
    if (previous !== undefined) assert.deepEqual(ref, previous, 'Duplicate declaration identity');
    sources.set(name, ref);
  }
  assert.ok(sources.size > 0, 'The pinned fixture must explicitly trace declarations');
  const modules = spec.modules.filter((module) => DECLARATION.test(module.name));
  for (const module of modules) {
    assert.equal(module.type, 'data', 'Traced declarations must be emitted as data modules');
  }
  const emitted = new Map(modules.map((module) => [module.name, module.blob]));
  assert.equal(emitted.size, modules.length, 'Duplicate emitted declaration name');
  assert.deepEqual(
    [...emitted.keys()].toSorted(compareNames),
    [...sources.keys()].toSorted(compareNames),
    'Emitted declaration names must exactly match the route trace',
  );
  const inventory = [...sources.values()].toSorted((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const source of inventory) {
    const blob = emitted.get(source.name);
    assert.ok(blob !== undefined);
    assert.equal(
      blob.sha256,
      source.sha256,
      'Emitted declaration must match its traced source hash',
    );
    assert.equal(
      blob.byteLength,
      source.byteLength,
      'Emitted declaration must match its traced source length',
    );
  }
  return inventory;
}
