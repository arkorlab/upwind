import {
  admitPublication,
  parseCacheTagsHeader,
  publicationExpired,
  publicationForBuild,
} from '@stayingupwind/core/cache';
import type { ProjectManifest, RouteEntry } from '@stayingupwind/core/manifest';

import type { ServedGeneration } from './document-delivery.ts';

interface BuiltDocument {
  readonly manifest: ProjectManifest;
  readonly entry: RouteEntry;
  readonly edge: { readonly runtime: { readonly now: () => number } };
}

function tags(input: { readonly entry: RouteEntry }): string[] {
  return [
    ...(input.entry.cache?.buildTags?.map((tag) => tag.value) ?? []),
    ...parseCacheTagsHeader(new Headers(input.entry.headers).get('x-next-cache-tags') ?? undefined),
  ];
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

/** Carry exactly the selected record's grants; a build fallback uses only its own original tags. */
export function documentPublicationTags(input: {
  readonly entry: RouteEntry;
  readonly generation?: ServedGeneration | undefined;
}): readonly string[] {
  if (input.generation !== undefined) {
    return input.generation.pack.header.tags?.map((tag) => tag.value) ?? [];
  }
  return tags(input);
}
