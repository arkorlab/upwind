import {
  admitPublication,
  parseCacheTagsHeader,
  publicationExpired,
  publicationForBuild,
  publicationForRoute,
} from '@stayingupwind/core/cache';
import type { ProjectManifest, RouteEntry } from '@stayingupwind/core/manifest';

import type { ServedGeneration } from './document-delivery.ts';

interface BuiltDocument {
  readonly manifest: ProjectManifest;
  readonly entry: RouteEntry;
  readonly edge: { readonly runtime: { readonly now: () => number } };
}

function tags(input: { readonly entry: RouteEntry }): string[] {
  const values = input.entry.cache?.buildTags?.map((tag) => tag.value) ?? [];
  return [...values, ...headerTags(input.entry.headers)];
}

function headerTags(headers: Readonly<Record<string, string>>): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'x-next-cache-tags') values.push(...parseCacheTagsHeader(value));
  }
  return values;
}

function requirement(input: BuiltDocument) {
  return publicationForBuild(
    input.manifest.publication,
    input.entry.cache?.route ?? input.entry.pathname,
  );
}

/** The shipped source is checked even when generation-record caching is disabled. */
export function builtDocumentExpired(input: BuiltDocument): boolean {
  return publicationExpired(tags(input), input.edge.runtime.now(), requirement(input));
}

export function admitBuiltDocument(input: BuiltDocument, response: Response): Response {
  return admitPublication(response, tags(input), input.edge.runtime.now(), requirement(input));
}

interface GateDocument extends BuiltDocument {
  readonly generation?: ServedGeneration | undefined;
}

function gateRequirement(input: GateDocument) {
  return publicationForRoute(
    input.manifest.publication,
    input.generation?.pack.header.route ?? input.entry.cache?.route ?? input.entry.pathname,
  );
}

/** Gate shells are freshly supplied records, and have not passed stored-generation admission. */
export function gateDocumentExpired(input: GateDocument): boolean {
  return (
    input.generation?.gate !== undefined &&
    publicationExpired(
      documentPublicationTags(input),
      input.edge.runtime.now(),
      gateRequirement(input),
    )
  );
}

export function admitGateDocument(input: GateDocument, response: Response): Response {
  if (input.generation?.gate === undefined) return response;
  return admitPublication(
    response,
    documentPublicationTags(input),
    input.edge.runtime.now(),
    gateRequirement(input),
  );
}

/** Carry exactly the selected record's grants; a build fallback uses only its own original tags. */
export function documentPublicationTags(input: {
  readonly entry: RouteEntry;
  readonly generation?: ServedGeneration | undefined;
}): readonly string[] {
  if (input.generation !== undefined) {
    const values = input.generation.pack.header.tags?.map((tag) => tag.value) ?? [];
    return input.generation.gate === undefined
      ? values
      : [...values, ...headerTags(input.generation.pack.header.headers)];
  }
  return tags(input);
}
