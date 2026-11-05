import { canonicalJson, sha256HexOfText } from '@stayingupwind/core/artifact';
import type { ImageRequestParams, ImagesConfig } from '@stayingupwind/core/images';

import { transformMode } from '../edge-runtime.ts';
import { imageSourceId } from './image-source-identity.ts';
import type { ImageSource } from './image-source.ts';
import type { ImageInput } from './image.ts';

/** Hex characters of the configuration's hash that tell one configuration from another. */
const CONFIG_FINGERPRINT_LENGTH = 16;
const fingerprints = new WeakMap<ImagesConfig, Promise<string>>();

/**
 * What of the configuration decides an entry: whether an SVG is served, how long a result may be
 * kept, which formats are offered. The cache is one for every hosted application, and one
 * application's answer must not be another's, nor a deployment's its own successor's once the
 * configuration changed — so the whole configuration goes into the key, by its hash.
 */
async function fingerprintOf(config: ImagesConfig): Promise<string> {
  const hex = await sha256HexOfText(canonicalJson(config));
  return hex.slice(0, CONFIG_FINGERPRINT_LENGTH);
}

function configFingerprint(config: ImagesConfig): Promise<string> {
  let fingerprint = fingerprints.get(config);
  if (fingerprint === undefined) {
    fingerprint = fingerprintOf(config);
    fingerprints.set(config, fingerprint);
  }
  return fingerprint;
}

/**
 * The key an image is kept under: the host's origin for them (`EdgeNames.imageKeyOrigin`), a name
 * nothing resolves, since the Cache API wants a URL and the key is the whole identity.
 */
async function cacheKey(
  origin: string,
  config: ImagesConfig,
  sourceId: string,
  params: ImageRequestParams,
): Promise<Request> {
  const format = params.mimeType === '' ? 'source' : params.mimeType;
  const fingerprint = await configFingerprint(config);
  return new Request(
    `${origin}/${fingerprint}/${sourceId}/${params.width}/${params.quality}/${format}`,
  );
}

/** Protected remote hits come only from writers that retained and checked source proof. */
export async function imageCacheKey(input: ImageInput, source: ImageSource): Promise<Request> {
  const mode = transformMode(input.edge.runtime.transformImage);
  const aware = input.manifest.publication !== undefined && source.kind === 'remote';
  const sourceId = `${mode}:${aware ? 'publication-aware-v1:' : ''}${await imageSourceId(source, input.edge)}`;
  return cacheKey(input.edge.host.names.imageKeyOrigin, input.config, sourceId, input.params);
}
