import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { DurableObjectDeclaration } from '@stayingupwind/core/bundle';

import { bundleDurableObjects } from '../../adapter/src/durable-objects.ts';

const PACKAGE_MANIFEST = 'package.json';
const CONDITIONAL_WORKER = 'worker.js';
const CONDITIONAL_NODE = 'node.js';
const UNEXPECTED_NODE_MARKER = 'node-branch-must-not-run';

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
  const names = ['sqlite', 'test', 'sea'];
  for (const name of names) {
    const directory = path.join(project, 'node_modules', name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, PACKAGE_MANIFEST), '{"main":"index.cjs"}');
    await writeFile(path.join(directory, 'index.cjs'), `module.exports = "package-${name}";`);
  }
  const source = 'prefix-only-counter.ts';
  await writeFile(
    path.join(project, source),
    'export class Counter { packages() { return [require("sqlite"), require("test"), require("sea")]; } }',
  );
  const [object] = await bundleDurableObjects(project, [{ ...declaration, module: source }]);
  assert.ok(object);
  for (const name of names) {
    assert.ok(object.inputs.includes(path.join(project, 'node_modules', name, 'index.cjs')));
    assert.ok(object.source.includes(`package-${name}`));
    assert.ok(!object.trace.externals.includes(`node:${name}`));
  }
}
