import {
  kvArtifactKey,
  r2ArtifactKey,
  sha256Hex,
  sha256HexOfText,
} from '@stayingupwind/core/artifact';
import type { DeploymentBundle } from '@stayingupwind/core/bundle';
import {
  type AppRuntime,
  parseProjectManifest,
  type ProjectManifest,
} from '@stayingupwind/core/manifest';
import { encodeUtf8 } from '@stayingupwind/core/util';
import type {
  CacheEnvironment,
  SeedEntriesInput,
  SeedEntriesResult,
  SeedScopeInput,
  SeedScopeResult,
} from '@stayingupwind/host/cache';
import type {
  CspNonceMode,
  DeliveryPolicy,
  EdgePointer,
  ShellBackendId,
} from '@stayingupwind/host/delivery';
import { scanPreloadLinks } from '@stayingupwind/host/preloads';
import { blobObjectKey, kvManifestKey, r2ManifestKey } from '@stayingupwind/host/storage';

import { cacheEntryIdsOf, seededGenerationAt, seedEntriesOf, seedScopeOf } from './cache-seed.ts';
import { type ShellPlacement, shellPlacementsOf, unimplementedBackend } from './delivery.ts';
import { deploymentFingerprintOf } from './fingerprint.ts';
import { assembleManifest, oversizedManifest } from './manifest.ts';
import { edgePointerOf } from './pointer.ts';
import { DOCUMENT_KIND, shellsOf } from './shells.ts';

/**
 * A deployment made from its build in one process, as two calls — `stageDeployment`, which imports
 * the build's shells, seeds its runtime cache and assembles its manifest, and `publishDeployment`,
 * which stores and places what the manifest names and hands back the pointer that sends a site's
 * requests to it.
 *
 * Each writes what it writes in one go, and neither proves that every route answers: that is the
 * caller's to prove, before it writes the pointer that sends requests to the deployment. Every key
 * written is the one the edge and the cache read (`@stayingupwind/host/storage`).
 */

/** The build's blobs, by digest: where its upload left them, or the directory it was built in. */
export interface DeployBlobs {
  /**
   * Whether they are in the bucket already, where an upload leaves them (`blobs/<sha256>`), which
   * the edge serves files from and a Function reads a left-out output from. A build directory's
   * are not, and staging copies them there.
   */
  readonly uploaded: boolean;
  read(sha256: string): Promise<Uint8Array | undefined>;
}

/**
 * The bucket a deployment's artifacts and manifest go to. Written without a read back: every key is
 * a digest or an id, so a write that finds the same bytes already there changes nothing. Read when a
 * deployment is published, for everything the publication relies on, each checked against its name.
 */
export interface DeployBucket {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array | string, options: BucketPutOptions): Promise<void>;
}

export interface BucketPutOptions {
  readonly contentType: string;
  readonly customMetadata?: Readonly<Record<string, string>> | undefined;
}

/**
 * The namespace the edge reads a deployment by: its placed shells and its manifest. Read back after
 * each write a publication relies on.
 */
export interface DeployNamespace {
  get(key: string): Promise<Uint8Array | undefined>;
  put(
    key: string,
    value: Uint8Array | string,
    metadata?: Readonly<Record<string, unknown>>,
  ): Promise<void>;
}

/** The cache authority's control entrypoint, as a deploy seeds a deployment's scope through it. */
export interface DeployCache {
  seedScope(input: SeedScopeInput): Promise<SeedScopeResult>;
  seedEntries(input: SeedEntriesInput): Promise<SeedEntriesResult>;
}

/**
 * Where a deployment comes from and goes: its build's blobs, the stores the edge reads, and the
 * authority of its runtime cache — absent for a host that runs none, whose deployments are then
 * served from their shells alone.
 */
export interface DeployTarget {
  readonly blobs: DeployBlobs;
  readonly bucket: DeployBucket;
  readonly edgeState: DeployNamespace;
  readonly cache?: DeployCache | undefined;
}

/** Why a deployment was refused: a code to branch on, beside the message that says why. */
export type DeployRefusalCode = 'backend_unsupported' | 'bundle_invalid' | 'cache_scope_conflict';

export class DeployRefusalError extends Error {
  readonly code: DeployRefusalCode;

  constructor(message: string, options: ErrorOptions & { readonly code: DeployRefusalCode }) {
    super(message, options);
    this.name = 'DeployRefusalError';
    this.code = options.code;
  }
}

export interface StageInput {
  readonly bundle: DeploymentBundle;
  /** The bundle as it was stored, which the deployment's fingerprint is the digest of. */
  readonly json: string;
  /** The deployment served before this one, whose `_next/static` files stay; none for a first. */
  readonly previous?: DeploymentBundle | undefined;
  readonly projectId: string;
  readonly runId: string;
  readonly originHost: string;
  readonly environment: CacheEnvironment;
  /** Whose the deployment is, as the host names its owners. */
  readonly owner: string;
  /** The deployment's Functions, as the host runs them. */
  readonly app: AppRuntime;
  /** The CSP source that authorises the recovery script a failed continuation ends in. */
  readonly recoverySource: string;
  /** What the host's history adds to the scope's seed (`ScopeHistory`); nothing, by default. */
  readonly history?: Omit<SeedScopeInput, 'scope'> | undefined;
  readonly now: () => number;
}

export interface StagedDeployment {
  readonly manifest: ProjectManifest;
  readonly manifestId: string;
  /** The manifest as it is stored, which its id is the digest of. */
  readonly serialized: string;
  /** What the deployment's Functions open its scope of the runtime cache with; none without one. */
  readonly token: string | undefined;
  /**
   * Every blob of the build staging checked (`stageBlobs`), which its cache entries and Functions
   * read from the bucket: a publication reads each again, as it stands then.
   */
  readonly blobs: readonly BlobRef[];
}

/** Entries per call: within `MAX_SEED_BATCH`, and as many as a failed call has to send again. */
const SEED_BATCH = 100;
const SHELL_CONTENT_TYPE = 'text/html; charset=utf-8';

function isoOf(ms: number): string {
  // eslint-disable-next-line unicorn/prefer-temporal -- Temporal is not available in the Workers runtime.
  return new Date(ms).toISOString();
}

/** Bytes as a build or a manifest names them: by their digest, and their length. */
export interface BlobRef {
  readonly sha256: string;
  readonly byteLength: number;
}

/**
 * Whether `bytes` are the ones `ref` names. Every key here is a digest, so bytes written under one
 * they are not would be taken for the blob they claim to be by every deployment that names it.
 */
async function holds(bytes: Uint8Array, ref: BlobRef): Promise<boolean> {
  return bytes.byteLength === ref.byteLength && (await sha256Hex(bytes)) === ref.sha256;
}

/**
 * A blob the build names, as the build names it; the refusal of a build that did not upload it, or
 * whose upload or directory holds other bytes under its name.
 */
async function blobOf(blobs: DeployBlobs, ref: BlobRef): Promise<Uint8Array> {
  const bytes = await blobs.read(ref.sha256);
  if (bytes === undefined) {
    throw new DeployRefusalError(`blob ${ref.sha256} was not uploaded`, { code: 'bundle_invalid' });
  }
  if (!(await holds(bytes, ref))) {
    throw new DeployRefusalError(`blob ${ref.sha256} holds other bytes than the build names`, {
      code: 'bundle_invalid',
    });
  }
  return bytes;
}

/**
 * Every blob of the build the edge or a Function reads from the bucket — each prerender's body and
 * postponed state, and each file — checked against its digest, and copied where an upload leaves it
 * for a build read from where it was built. A build found uploaded is checked all the same: a blob
 * it names that is missing or other bytes would fail a read the deployment's Functions or its cache
 * make after it was published. Function modules are not among them: a host deploys its Functions.
 */
async function stageBlobs(target: DeployTarget, bundle: DeploymentBundle): Promise<BlobRef[]> {
  const refs = [
    ...bundle.prerenders.flatMap((prerender) => [prerender.body, prerender.postponed]),
    ...bundle.staticFiles.map((file) => file.blob),
  ];
  const checked = new Map<string, BlobRef>();
  for (const ref of refs) {
    if (ref === undefined || checked.has(ref.sha256)) {
      continue;
    }
    checked.set(ref.sha256, { sha256: ref.sha256, byteLength: ref.byteLength });
    const bytes = await blobOf(target.blobs, ref);
    if (!target.blobs.uploaded) {
      await target.bucket.put(blobObjectKey(ref.sha256), bytes, { contentType: ref.contentType });
    }
  }
  return [...checked.values()];
}

/**
 * The build's shells, prefetch segments, whole payloads and Pages Router props, kept where the edge
 * reads an artifact from (`artifacts/<sha256>`), and the hints each document's head names, by its
 * digest.
 */
async function importShells(
  target: DeployTarget,
  input: StageInput,
): Promise<Record<string, string[]>> {
  const preloads: Record<string, string[]> = {};
  for (const shell of shellsOf(input.bundle)) {
    const bytes = await blobOf(target.blobs, shell);
    await target.bucket.put(r2ArtifactKey(shell.sha256), bytes, {
      contentType: SHELL_CONTENT_TYPE,
      customMetadata: {
        kind: shell.kind,
        byteLength: String(shell.byteLength),
        sourcePath: shell.sourcePath,
        sourceOriginHost: input.originHost,
        deploymentId: input.bundle.deploymentId,
        capturedAt: isoOf(input.now()),
      },
    });
    // Only a document has a head to read hints from: a segment or a payload is an RSC payload, and
    // a page's props are JSON.
    if (shell.kind === DOCUMENT_KIND) {
      const links = scanPreloadLinks(bytes);
      if (links.length > 0) {
        preloads[shell.sha256] = links;
      }
    }
  }
  return preloads;
}

/** The deployment's scope, and the build's generation of every entry; the scope's token back. */
async function seedCache(cache: DeployCache, input: StageInput): Promise<string> {
  const { bundle } = input;
  const scopeId = bundle.deploymentId;
  const seeded = await cache.seedScope({
    ...input.history,
    scope: seedScopeOf({
      deploymentId: scopeId,
      projectId: input.projectId,
      environment: input.environment,
      buildId: bundle.buildId,
      owner: input.owner,
    }),
  });
  if (seeded.kind === 'conflict') {
    throw new DeployRefusalError(seeded.reason, { code: 'cache_scope_conflict' });
  }
  const ids = cacheEntryIdsOf(bundle);
  const context = { scopeId, generatedAt: seededGenerationAt(bundle, input.now()) };
  for (let batchIndex = 0; batchIndex * SEED_BATCH < ids.length; batchIndex += 1) {
    const batch = ids.slice(batchIndex * SEED_BATCH, (batchIndex + 1) * SEED_BATCH);
    const entries = await seedEntriesOf(bundle, batch, context);
    await cache.seedEntries({ scopeId, batchIndex, entries });
  }
  return seeded.token;
}

/**
 * Stage a deployment, before anything of it is published: the build's fingerprint taken, its blobs
 * uploaded where they are not yet, its shells imported, its runtime cache seeded, and its manifest
 * assembled from all of it. Nothing the edge reads by a manifest has been written yet, so a refusal
 * here leaves nothing to serve.
 *
 * No renderings: a host that compresses its shells ahead of a request passes them to
 * `assembleManifest` itself; these leave the edge to send each shell as it was stored.
 */
export async function stageDeployment(
  target: DeployTarget,
  input: StageInput,
): Promise<StagedDeployment> {
  const { bundle } = input;
  const fingerprint = await deploymentFingerprintOf(bundle, input.json, isoOf(input.now()));
  const blobs = await stageBlobs(target, bundle);
  const preloads = await importShells(target, input);
  const token = target.cache === undefined ? undefined : await seedCache(target.cache, input);
  const assembled = await assembleManifest({
    bundle,
    previous: input.previous,
    projectId: input.projectId,
    runId: input.runId,
    originHost: input.originHost,
    deploymentId: bundle.deploymentId,
    fingerprint,
    app: input.app,
    generatedAt: isoOf(input.now()),
    encodings: new Map(),
    preloads,
    recoverySource: input.recoverySource,
    runtimeCache: target.cache !== undefined,
  });
  if (assembled.kind === 'refused') {
    throw new DeployRefusalError(assembled.reason, { code: 'bundle_invalid' });
  }
  const { manifest, manifestId, serialized } = assembled;
  return { manifest, manifestId, serialized, token, blobs };
}

/**
 * An object a publication relies on, as the bucket holds it now: there, and holding the bytes its
 * digest names. A staged deployment may be published long after it was staged, and long after the
 * directory it was built in went, so what it relies on is read as it stands then.
 */
async function storedAs(
  target: DeployTarget,
  key: string,
  ref: BlobRef,
  what: string,
): Promise<Uint8Array> {
  const bytes = await target.bucket.get(key);
  if (bytes === undefined) {
    throw new DeployRefusalError(`${what} ${ref.sha256} is no longer stored`, {
      code: 'bundle_invalid',
    });
  }
  if (!(await holds(bytes, ref))) {
    throw new DeployRefusalError(`${what} ${ref.sha256} holds other bytes than its name`, {
      code: 'bundle_invalid',
    });
  }
  return bytes;
}

/**
 * A shell, placed where the policy's shell backend reads it from: in KV beside the edge's other
 * state, from the artifact staging stored, or nowhere new under an R2 policy, where that artifact
 * is the placement. Either way the artifact is read as it is now (`storedAs`).
 */
async function placeShell(
  target: DeployTarget,
  backend: ShellBackendId,
  shell: ShellPlacement,
): Promise<void> {
  const bytes = await storedAs(target, r2ArtifactKey(shell.sha256), shell, 'artifact');
  if (backend === 'r2') {
    return;
  }
  // No renderings beside it: `stageDeployment` assembles none (see there).
  const key = kvArtifactKey(shell.sha256);
  await target.edgeState.put(key, bytes, {
    contentType: shell.contentType,
    byteLength: shell.byteLength,
    sha256: shell.sha256,
    sourcePath: shell.sourcePath,
    encoding: 'identity',
  });
  await readBack((written) => target.edgeState.get(written), key, shell);
}

/**
 * What a publication adds to what was staged. The site and the Functions a pointer names are the
 * staged manifest's own, so that a pointer can never name an origin its manifest was not built for —
 * which the edge would answer by passing every request through.
 */
export interface PublishInput {
  /**
   * What the edge delivers the deployment under: its backends, holds and lifetimes. Named by the
   * pointer and read for its backends, and not written: an id names one policy for good, to every
   * pointer and every isolate that holds it, and the edge's namespace offers no write that could
   * refuse a second policy under it. So publishing a policy (`policy:<id>`) is the host's, once,
   * where it can keep that promise — behind a write that refuses an id already taken.
   */
  readonly policy: DeliveryPolicy;
  readonly cspNonce?: boolean | undefined;
  readonly cspNonceMode?: CspNonceMode | undefined;
  readonly cspStrictDynamic?: boolean | undefined;
  readonly now: () => number;
}

/**
 * Every blob a publication relies on, where it is read from (`blobs/<sha256>`) and as its digest
 * names it (`storedAs`): each the build's cache entries and Functions read (`StagedDeployment.blobs`),
 * and each file the manifest serves. A staged deployment may be published long after it was staged,
 * and the edge does not hash a file it serves. The files take in those the deployment before built,
 * by their own entries and beside this build's (`previous`), which its documents still open ask for:
 * a deployment staged with a `previous` whose files this bucket does not hold is refused, to be
 * staged without it or once they are stored.
 */
async function requireBlobs(
  target: DeployTarget,
  staged: readonly BlobRef[],
  manifest: ProjectManifest,
): Promise<void> {
  const refs = new Map(staged.map((ref) => [ref.sha256, ref]));
  const files = Object.values(manifest.staticFiles ?? {});
  for (const file of files) {
    refs.set(file.sha256, file);
    if (file.previous !== undefined) {
      refs.set(file.previous.sha256, file.previous);
    }
  }
  for (const ref of refs.values()) {
    await storedAs(target, blobObjectKey(ref.sha256), ref, 'blob');
  }
}

/**
 * A write a publication relies on, read back: a store that lost the value or changed it refuses the
 * deployment, before the pointer that would send requests to it exists.
 */
async function readBack(
  read: (key: string) => Promise<Uint8Array | undefined>,
  key: string,
  ref: BlobRef,
): Promise<void> {
  const bytes = await read(key);
  if (bytes === undefined || !(await holds(bytes, ref))) {
    throw new DeployRefusalError(`${key} does not hold what was written to it`, {
      code: 'bundle_invalid',
    });
  }
}

/**
 * The manifest a staged deployment publishes, read from the bytes it stores: those bytes are what
 * the edge reads and checks against the id, so they, and not an object beside them, are what is
 * placed and pointed to. A manifest changed after staging is held to what staging held it to: its
 * bytes the digest of its id, a manifest the edge reads, and within what the edge holds
 * (`oversizedManifest`). Anything else is refused.
 */
async function manifestOf(
  staged: Pick<StagedDeployment, 'manifestId' | 'serialized'>,
): Promise<ProjectManifest> {
  if ((await sha256HexOfText(staged.serialized)) !== staged.manifestId) {
    throw new DeployRefusalError(`manifest ${staged.manifestId} is not the digest of its bytes`, {
      code: 'bundle_invalid',
    });
  }
  let manifest: ProjectManifest;
  try {
    manifest = parseProjectManifest(staged.serialized);
  } catch (error) {
    throw new DeployRefusalError(`manifest ${staged.manifestId} is not one the edge reads`, {
      code: 'bundle_invalid',
      cause: error,
    });
  }
  const oversized = oversizedManifest(manifest, staged.serialized);
  if (oversized !== undefined) {
    throw new DeployRefusalError(oversized, { code: 'bundle_invalid' });
  }
  return manifest;
}

/**
 * Publish a staged deployment: the manifest stored, every shell it names placed, then the manifest
 * where the edge reads it — and the pointer that sends the site's requests to it, under its policy,
 * for the caller to write where its edge looks.
 */
export async function publishDeployment(
  target: DeployTarget,
  staged: Pick<StagedDeployment, 'blobs' | 'manifestId' | 'serialized'>,
  input: PublishInput,
): Promise<EdgePointer> {
  const unimplemented = unimplementedBackend(input.policy);
  if (unimplemented !== undefined) {
    throw new DeployRefusalError(`the edge reads nothing from ${unimplemented}`, {
      code: 'backend_unsupported',
    });
  }
  const manifest = await manifestOf(staged);
  await requireBlobs(target, staged.blobs, manifest);
  const stored: BlobRef = {
    sha256: staged.manifestId,
    byteLength: encodeUtf8(staged.serialized).byteLength,
  };
  await target.bucket.put(r2ManifestKey(staged.manifestId), staged.serialized, {
    contentType: 'application/json',
  });
  await readBack((key) => target.bucket.get(key), r2ManifestKey(staged.manifestId), stored);
  for (const shell of shellPlacementsOf(manifest)) {
    await placeShell(target, input.policy.shell.backend, shell);
  }
  await target.edgeState.put(kvManifestKey(staged.manifestId), staged.serialized);
  await readBack((key) => target.edgeState.get(key), kvManifestKey(staged.manifestId), stored);
  return edgePointerOf(
    { projectId: manifest.projectId, originHost: manifest.origin.host },
    {
      fingerprint: manifest.deployment,
      manifestId: staged.manifestId,
      policyId: input.policy.id,
      app: manifest.app,
      cspNonce: input.cspNonce ?? false,
      cspNonceMode: input.cspNonceMode,
      cspStrictDynamic: input.cspStrictDynamic,
    },
    input.now(),
  );
}

/** A deployment staged and published in one call (`stageDeployment`, `publishDeployment`). */
export async function deployBundle(
  target: DeployTarget,
  input: Pick<PublishInput, 'cspNonce' | 'cspNonceMode' | 'cspStrictDynamic' | 'policy'> &
    StageInput,
): Promise<{ readonly staged: StagedDeployment; readonly pointer: EdgePointer }> {
  const staged = await stageDeployment(target, input);
  return { staged, pointer: await publishDeployment(target, staged, input) };
}
