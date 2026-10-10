import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type DurableObjectDeclaration,
  durableObjectDeclarationsSchema,
} from '@stayingupwind/core/bundle';
import {
  RESOURCE_CHANGES_SERVICE_BINDING,
  UPWIND_DURABLE_OBJECTS_ENV,
} from '@stayingupwind/core/paas';

import { BlobStore } from '../../adapter/src/blobs.ts';
import { bundleDurableObjects, durableObjectParts } from '../../adapter/src/durable-objects.ts';

const PACKAGE_MANIFEST = 'package.json';
const CONDITIONAL_WORKER = 'worker.js';
const CONDITIONAL_NODE = 'node.js';
const UNEXPECTED_NODE_MARKER = 'node-branch-must-not-run';
const NON_INTEGER_REVISION = 1.5;

export async function checkDefinitionRevision(
  project: string,
  declaration: DurableObjectDeclaration,
): Promise<void> {
  await assert.rejects(
    bundleDurableObjects(project, [{ ...declaration, name: RESOURCE_CHANGES_SERVICE_BINDING }]),
    /reserved/u,
  );
  const outDir = path.join(project, '.arkor');
  const blobs = new BlobStore(outDir);
  await blobs.init();
  const revised = { ...declaration, definitionRevision: 17 };
  const input = { projectDir: project, outDir, blobs };
  for (const split of [false, true]) {
    const baseline = await durableObjectParts({ ...input, split, declarations: [declaration] });
    const parts = await durableObjectParts({ ...input, split, declarations: [revised] });
    assert.deepEqual(parts.bundle.durableObjects, [revised]);
    assert.deepEqual(parts.functions, baseline.functions);
  }
  for (const definitionRevision of [-1, 0, NON_INTEGER_REVISION, Number.MAX_SAFE_INTEGER + 1, '17'])
    assert.ok(
      !durableObjectDeclarationsSchema.safeParse([{ ...declaration, definitionRevision }]).success,
    );
  const previous = process.env[UPWIND_DURABLE_OBJECTS_ENV];
  try {
    process.env[UPWIND_DURABLE_OBJECTS_ENV] = JSON.stringify([revised]);
    const fromHost = await durableObjectParts({ ...input, split: false, declarations: undefined });
    assert.deepEqual(fromHost.bundle.durableObjects, [revised]);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, UPWIND_DURABLE_OBJECTS_ENV);
    else process.env[UPWIND_DURABLE_OBJECTS_ENV] = previous;
  }
}

export async function checkBuildResolution(
  project: string,
  declaration: DurableObjectDeclaration,
): Promise<void> {
  const conditionalPackage = path.join(project, 'node_modules', 'upwind-condition-test');
  await mkdir(conditionalPackage, { recursive: true });
  await writeFile(
    path.join(conditionalPackage, PACKAGE_MANIFEST),
    JSON.stringify({
      type: 'module',
      exports: {
        node: `./${CONDITIONAL_NODE}`,
        workerd: `./${CONDITIONAL_WORKER}`,
        default: `./${CONDITIONAL_NODE}`,
      },
    }),
  );
  await writeFile(
    path.join(conditionalPackage, CONDITIONAL_WORKER),
    'export const condition = "workerd";',
  );
  await writeFile(
    path.join(conditionalPackage, CONDITIONAL_NODE),
    'throw new Error("node-branch-must-not-run"); export const condition = "node";',
  );
  const conditionalModule = 'conditional-counter.ts';
  await writeFile(
    path.join(project, conditionalModule),
    'import { condition } from "upwind-condition-test"; export { Counter } from "./counter.ts"; if (condition !== "workerd") throw new Error("unexpected-condition");',
  );
  const conditional = await bundleDurableObjects(project, [
    { ...declaration, module: conditionalModule },
  ]);
  assert.ok(
    conditional[0]?.inputs.includes(path.join(conditionalPackage, CONDITIONAL_WORKER)) === true,
  );
  assert.ok(!conditional[0].source.includes(UNEXPECTED_NODE_MARKER));
  await writeFile(
    path.join(conditionalPackage, PACKAGE_MANIFEST),
    JSON.stringify({
      type: 'module',
      exports: {
        node: `./${CONDITIONAL_NODE}`,
        browser: `./${CONDITIONAL_WORKER}`,
        default: `./${CONDITIONAL_NODE}`,
      },
    }),
  );
  const browser = await bundleDurableObjects(project, [
    { ...declaration, module: conditionalModule },
  ]);
  assert.ok(
    browser[0]?.inputs.includes(path.join(conditionalPackage, CONDITIONAL_WORKER)) === true,
  );
  assert.ok(!browser[0].source.includes(UNEXPECTED_NODE_MARKER));
  await writeFile(
    path.join(conditionalPackage, PACKAGE_MANIFEST),
    JSON.stringify({
      type: 'module',
      main: `./${CONDITIONAL_NODE}`,
      browser: `./${CONDITIONAL_WORKER}`,
    }),
  );
  const legacy = await bundleDurableObjects(project, [
    { ...declaration, module: conditionalModule },
  ]);
  assert.ok(legacy[0]?.inputs.includes(path.join(conditionalPackage, CONDITIONAL_WORKER)) === true);
  assert.ok(!legacy[0].source.includes(UNEXPECTED_NODE_MARKER));
  await writeFile(
    path.join(conditionalPackage, PACKAGE_MANIFEST),
    JSON.stringify({
      type: 'module',
      main: `./${CONDITIONAL_WORKER}`,
      browser: { [`./${CONDITIONAL_NODE}`]: './browser.js' },
    }),
  );
  await writeFile(
    path.join(conditionalPackage, CONDITIONAL_WORKER),
    'export { condition } from "./node.js";',
  );
  await writeFile(
    path.join(conditionalPackage, 'browser.js'),
    'export const condition = "workerd";',
  );
  const remapped = await bundleDurableObjects(project, [
    { ...declaration, module: conditionalModule },
  ]);
  assert.ok(remapped[0]?.inputs.includes(path.join(conditionalPackage, 'browser.js')) === true);
  assert.ok(!remapped[0].source.includes(UNEXPECTED_NODE_MARKER));
  const modeModule = 'mode-counter.ts';
  await writeFile(
    path.join(project, modeModule),
    'export class Counter { mode() { return [process.env.NODE_ENV, global.process.env.NODE_ENV, globalThis.process.env.NODE_ENV].join(":"); } }',
  );
  const modes = [{}, { mode: 'development' as const }];
  for (const options of modes) {
    const [object] = await bundleDurableObjects(
      project,
      [{ ...declaration, module: modeModule }],
      options,
    );
    assert.ok(object);
    assert.ok(object.source.includes(options.mode ?? 'production'));
    assert.ok(!object.source.includes('process.env.NODE_ENV'));
  }
}

export async function checkPrefixOnlyImports(
  project: string,
  declaration: DurableObjectDeclaration,
): Promise<void> {
  const names = ['sqlite', 'test', 'sea', 'string_decoder', 'buffer'];
  for (const name of names) {
    const directory = path.join(project, 'node_modules', name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, PACKAGE_MANIFEST), '{"main":"index.cjs"}');
    await writeFile(path.join(directory, 'index.cjs'), `module.exports = "package-${name}";`);
  }
  const source = 'prefix-only-counter.ts';
  await writeFile(
    path.join(project, source),
    'import { StringDecoder } from "string_decoder"; import { Buffer } from "buffer"; export class Counter { packages() { return [require("sqlite"), require("test"), require("sea"), require("string_decoder/"), require("buffer/"), typeof StringDecoder, Buffer.byteLength("native")]; } }',
  );
  const [object] = await bundleDurableObjects(project, [{ ...declaration, module: source }]);
  assert.ok(object);
  for (const name of names) {
    assert.ok(object.inputs.includes(path.join(project, 'node_modules', name, 'index.cjs')));
    assert.ok(object.source.includes(`package-${name}`));
    if (name !== 'string_decoder' && name !== 'buffer')
      assert.ok(!object.trace.externals.includes(`node:${name}`));
  }
  assert.ok(object.trace.externals.includes('node:string_decoder'));
  assert.ok(object.trace.externals.includes('node:buffer'));
}
