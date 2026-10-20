import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type BlobRef,
  bundleBlobs,
  type DeploymentBundle,
  type Prerender,
  primaryPrerenders,
  standsForClass,
} from '@stayingupwind/core/bundle';

import { type CaseProof, exercise, modulesOf, sha256 } from './large-prerender-worker.ts';
import { failureOf, type Failure } from './twoslash-probes.ts';

const MIB = 1_048_576;
const MAX_FUNCTION_BYTES = 67_108_864;
const MAX_BODY_BYTES = 33_554_432;
const TOTAL_MS = 180_000;
const PAGE_COUNT = 60;
const PREFIX = '/memory-pressure/';
const OFFICIAL_COMMIT = '2864b1772c37242a9b40ab4d366eb7d368c2a070';
const OFFICIAL_HASHES: Readonly<Record<string, string>> = {
  'next.config.js': 'e5e89d80a758c13732cb28f5a416b58422dbebe6774e6c5c6cae32c98f4644fc',
  'app/memory-pressure/[step]/page.tsx':
    '206d8809a823019fda8ba69c75a616167b097075884a807aaa5f8adf79c4adc1',
  'app/memory-pressure/[step]/layout.tsx':
    '3af7ea7b9b375a5e9a2d4db476c12eaeceb5ae57b32a5d5f971a09cfd7de953b',
};
interface BodyProof {
  pathname: string;
  kind: 'html' | 'rsc';
  sha256: string;
  byteLength: number;
}
interface OutputEvidence {
  pathname: string;
  primary: boolean;
  segment: boolean;
  response: string | null;
  compute: string | null;
  renderingMode: string | null;
  postponed: boolean;
  partialFallback: boolean;
  byteLength: number | null;
  shipped: boolean;
}
interface Proof {
  version: 1;
  status: 'running' | 'passed' | 'failed';
  stage: string;
  checkingPathname?: string;
  inventory: OutputEvidence[];
  sdkHead: string | null;
  nextVersion: string;
  officialCommit: string;
  sourceSha256: Record<string, string>;
  optionOffBaseline: 'not-measured';
  omitted: BodyProof[];
  omittedUniqueBytes: number;
  modulesVerified: number;
  functionSize?: { bytes: number; gzipBytes: number };
  moduleBytes: number;
  cases: CaseProof[];
  failure?: Failure;
}

function recordedSize(dependencies: unknown): { bytes: number; gzipBytes: number } {
  assert.ok(typeof dependencies === 'object' && dependencies !== null && 'app' in dependencies);
  const app = dependencies.app;
  assert.ok(typeof app === 'object' && app !== null && 'size' in app);
  const size = app.size;
  assert.ok(typeof size === 'object' && size !== null && 'bytes' in size && 'gzipBytes' in size);
  const { bytes, gzipBytes } = size;
  assert.ok(typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0);
  assert.ok(typeof gzipBytes === 'number' && Number.isSafeInteger(gzipBytes) && gzipBytes >= 0);
  return { bytes, gzipBytes };
}

function requiredBody(prerender: Prerender | undefined): BlobRef {
  assert.ok(prerender?.body !== undefined, 'Required build body reference');
  return prerender.body;
}

function selectedOutputs(bundle: DeploymentBundle, proof: Proof) {
  const primary = primaryPrerenders(bundle.prerenders);
  const modules = new Set(bundle.functions.app.modules.map((module) => module.blob.sha256));
  const candidates = bundle.prerenders.filter((entry) => entry.pathname.startsWith(PREFIX));
  proof.inventory = candidates.map((entry) => {
    return {
      pathname: entry.pathname,
      primary: primary.get(entry.id)?.id === entry.id,
      segment: entry.segmentPath !== undefined,
      response: entry.response ?? null,
      compute: entry.compute ?? null,
      renderingMode: entry.renderingMode ?? null,
      postponed: entry.postponed !== undefined,
      partialFallback: entry.partialFallback === true,
      byteLength: entry.body?.byteLength ?? null,
      shipped: entry.body !== undefined && modules.has(entry.body.sha256),
    };
  });
  const expected = new Set(
    Array.from({ length: PAGE_COUNT }, (_, index) => `${PREFIX}${String(index)}`),
  );
  const documents = candidates.filter(
    (entry) => expected.has(entry.pathname) && primary.get(entry.id)?.id === entry.id,
  );
  proof.stage = 'generated-page-count';
  assert.equal(documents.length, PAGE_COUNT, 'Unmodified official concrete page count');
  assert.deepEqual(
    new Set(documents.map((entry) => entry.pathname)),
    expected,
    'Every official generated path',
  );
  proof.stage = 'extra-concrete-documents';
  for (const entry of candidates) {
    if (primary.get(entry.id)?.id !== entry.id || expected.has(entry.pathname)) continue;
    assert.ok(
      standsForClass(entry) || entry.response !== 'complete' || entry.compute !== 'static',
      'Unexpected additional complete concrete page',
    );
  }
  const selected: { entry: Prerender; kind: 'html' | 'rsc' }[] = [];
  for (const document of documents) {
    proof.checkingPathname = document.pathname;
    proof.stage = 'document-response';
    assert.equal(document.response, 'complete', 'Completed document');
    proof.stage = 'document-compute';
    assert.equal(document.compute, 'static', 'Static document');
    proof.stage = 'document-postponed';
    assert.equal(document.postponed, undefined, 'No postponed state');
    selected.push({ entry: document, kind: 'html' });
    const rsc = bundle.prerenders.find((entry) => {
      return (
        entry.pathname === `${document.pathname}${bundle.routing.rsc.suffix}` &&
        primary.get(entry.id)?.id === document.id &&
        entry.segmentPath === undefined
      );
    });
    proof.stage = 'whole-rsc-reference';
    assert.ok(rsc !== undefined, 'Whole RSC for every generated document');
    selected.push({ entry: rsc, kind: 'rsc' });
  }
  proof.stage = 'unselected-fallback-bodies';
  const selectedIds = new Set(selected.map((item) => item.entry.id));
  for (const entry of candidates) {
    if (selectedIds.has(entry.id) || entry.segmentPath !== undefined || entry.body === undefined)
      continue;
    proof.checkingPathname = entry.pathname;
    assert.ok(
      modules.has(entry.body.sha256),
      'Unselected class/fallback bodies must remain embedded',
    );
  }
  const document = documents.find((entry) => entry.pathname === `${PREFIX}0`);
  const rsc = selected.find(
    (item) => item.kind === 'rsc' && primary.get(item.entry.id)?.id === document?.id,
  )?.entry;
  const small = bundle.prerenders.find(
    (entry) => entry.pathname === '/small' && primary.get(entry.id)?.id === entry.id,
  );
  assert.ok(document !== undefined && rsc !== undefined && small !== undefined);
  return { selected, document, rsc, small };
}

async function verifyOmitted(
  bundle: DeploymentBundle,
  out: string,
  proof: Proof,
  selected: ReturnType<typeof selectedOutputs>['selected'],
): Promise<void> {
  const modules = new Set(bundle.functions.app.modules.map((module) => module.blob.sha256));
  const upload = bundleBlobs(bundle);
  const unique = new Map<string, number>();
  for (const { entry, kind } of selected) {
    proof.checkingPathname = entry.pathname;
    proof.stage = 'body-reference';
    const ref = requiredBody(entry);
    proof.stage = 'body-range';
    assert.ok(
      ref.byteLength >= MIB && ref.byteLength <= MAX_BODY_BYTES,
      'Body falls within the configured inclusive range',
    );
    proof.stage = 'body-not-in-function';
    assert.equal(modules.has(ref.sha256), false, 'Large body must not remain a Function module');
    proof.stage = 'body-upload-reference';
    assert.deepEqual(upload.get(ref.sha256), ref, 'Bundle still references the uploaded blob');
    proof.stage = 'body-upload-bytes';
    const bytes = await readFile(path.join(out, 'blobs', ref.sha256));
    assert.equal(bytes.byteLength, ref.byteLength, 'Uploaded body byte length');
    assert.equal(sha256(bytes), ref.sha256, 'Uploaded body hash');
    proof.omitted.push({
      pathname: entry.pathname,
      kind,
      sha256: ref.sha256,
      byteLength: ref.byteLength,
    });
    unique.set(ref.sha256, ref.byteLength);
  }
  proof.stage = 'omitted-total-size';
  for (const size of unique.values()) proof.omittedUniqueBytes += size;
  assert.ok(
    proof.omittedUniqueBytes > MAX_FUNCTION_BYTES,
    'Omitted body bytes alone exceed the unchanged Function limit',
  );
}

/** A real large Next build followed by isolated requests through its unchanged emitted Function. */
export async function largePrerenderHolds(
  bundle: DeploymentBundle,
  dependencies: unknown,
  out: string,
): Promise<string[]> {
  const directory = process.env['UPWIND_MATRIX_PROOF_DIR'] ?? out;
  const proof: Proof = {
    version: 1,
    status: 'running',
    stage: 'fixture-hashes',
    inventory: [],
    sdkHead: process.env['UPWIND_MATRIX_SDK_HEAD'] ?? null,
    nextVersion: bundle.nextVersion,
    officialCommit: OFFICIAL_COMMIT,
    sourceSha256: {},
    optionOffBaseline: 'not-measured',
    omitted: [],
    omittedUniqueBytes: 0,
    modulesVerified: 0,
    moduleBytes: 0,
    cases: [],
  };
  try {
    assert.deepEqual(Object.keys(bundle.functions), ['app'], 'Single normal app Function');
    const app = path.dirname(out);
    for (const [file, expected] of Object.entries(OFFICIAL_HASHES)) {
      const actual = sha256(await readFile(path.join(app, file)));
      proof.sourceSha256[file] = actual;
      assert.equal(actual, expected, 'Pinned official fixture source hash');
    }
    for (const file of [
      'package.json',
      'app/layout.tsx',
      'app/small/page.tsx',
      'adapter.mjs',
      'blob-host.js',
    ])
      proof.sourceSha256[file] = sha256(await readFile(path.join(app, file)));
    const outputs = selectedOutputs(bundle, proof);
    await verifyOmitted(bundle, out, proof, outputs.selected);
    proof.stage = 'small-shipped-control';
    const small = requiredBody(outputs.small);
    assert.ok(small.byteLength < MIB, 'Small-page control stays below the lower threshold');
    assert.ok(
      bundle.functions.app.modules.some((module) => module.blob.sha256 === small.sha256),
      'Small-page control remains shipped',
    );
    proof.stage = 'function-size';
    proof.functionSize = recordedSize(dependencies);
    proof.moduleBytes = bundle.functions.app.modules.reduce(
      (total, module) => total + module.blob.byteLength,
      0,
    );
    assert.equal(
      proof.moduleBytes,
      proof.functionSize.bytes,
      'Actual Function byte count matches the recorded upload',
    );
    assert.ok(proof.moduleBytes <= MAX_FUNCTION_BYTES, 'Unchanged64MiB Function limit');
    proof.stage = 'uploaded-modules';
    const modules = await modulesOf(bundle, out);
    proof.modulesVerified = modules.length;
    const signal = AbortSignal.timeout(TOTAL_MS);
    for (const mode of [
      'html',
      'rsc',
      'head',
      'small',
      'missing',
      'wrong-size',
      'no-reader',
      'no-reader-head',
      'small-head-no-reader',
    ] as const) {
      proof.stage = `worker-${mode}`;
      const target = mode === 'rsc' ? outputs.rsc : outputs.document;
      const smallControl = mode === 'small' || mode === 'small-head-no-reader';
      const expected = smallControl ? small : requiredBody(target);
      const pathname = smallControl ? '/small' : outputs.document.pathname;
      proof.cases.push(await exercise({ bundle, modules, out, signal, mode, pathname, expected }));
    }
    assert.ok(
      proof.cases.every((item) => item.status === 'passed'),
      'Every body read, zero-read and failure contract',
    );
    proof.stage = 'complete';
    proof.status = 'passed';
  } catch (error) {
    proof.failure = failureOf(error);
    proof.status = 'failed';
  } finally {
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `large-prerender-${bundle.nextVersion}.json`),
      `${JSON.stringify(proof, null, 2)}\n`,
    );
  }
  return proof.status === 'passed'
    ? []
    : ['Large completed page compatibility failed; see the large-prerender proof artifact'];
}
