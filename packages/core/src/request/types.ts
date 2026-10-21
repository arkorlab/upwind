import type { DeploymentFingerprint } from '../deployment/fingerprint.ts';
import type {
  RouteEntry,
  RouteBodyEntry,
  StaticPageEntry,
  PagesFallbackEntry,
  ProjectManifest,
  StaticFileEntry,
} from '../manifest/schema.ts';

export type PassthroughReason =
  | 'method'
  | 'service-worker'
  | 'range'
  | 'well-known'
  | 'next-internal'
  | 'router-header'
  | 'internal-header'
  | 'bot'
  | 'html-limited-bots'
  | 'bypass-cookie'
  | 'vdpl-mismatch'
  | 'cookie'
  | 'bypass-query'
  | 'dpl-mismatch'
  | 'sec-fetch-dest'
  | 'sec-fetch-mode'
  | 'accept'
  | 'no-manifest'
  | 'repeated-slash'
  | 'route-body-bypass'
  | 'static-page-bypass'
  | 'route-not-proved';

export type RequestClass =
  /** `entry.pathname` is the manifest key: the pathname itself, or the template of its class. */
  | { readonly kind: 'document'; readonly entry: RouteEntry }
  /** A complete non-HTML body, read only from the host's trusted cache record. */
  | { readonly kind: 'route-body'; readonly entry: RouteBodyEntry }
  /** An exact static Pages build document, subject to its versioned record proof. */
  | {
      readonly kind: 'static-page';
      readonly entry: StaticPageEntry;
      readonly representation?: 'pages-data';
    }
  | {
      readonly kind: 'pages-fallback';
      readonly entry: PagesFallbackEntry;
      readonly parameters: Readonly<Record<string, string>>;
      readonly pathname: string;
      readonly dataPathname: string;
      readonly representation: 'html' | 'pages-data';
    }
  | { readonly kind: 'immutable-asset-candidate'; readonly originUrl: URL }
  /** A file the manifest holds by content: served from storage, and nobody is asked. */
  | { readonly kind: 'static-file'; readonly pathname: string; readonly file: StaticFileEntry }
  | { readonly kind: 'rsc' }
  /**
   * A router prefetch of part of a page: `segmentPath` is the `next-router-segment-prefetch` it
   * asks under, and `entry` the route it belongs to — `undefined` where the build proved none, as
   * it is for a document at a pathname the build never wrote.
   */
  | {
      readonly kind: 'segment-prefetch';
      readonly segmentPath: string;
      readonly entry: RouteEntry | undefined;
    }
  /**
   * A router's request for the whole payload of a page: the build payload, or a cache-backed
   * App Router generation which can supply one. `entry` is the route its URL names, or absent
   * for a dynamic class with no shell whose concrete member record the host must check.
   * Other requests for React Server Components remain `rsc`.
   */
  | { readonly kind: 'rsc-payload'; readonly entry: RouteEntry | undefined }
  /**
   * A Pages Router client's request for a page's props, at a page whose props the build wrote
   * (`RouteEntry.pagesData`): `entry` is that page's route. Any other `/_next/data` request is the
   * Function's, as every one was before.
   */
  | { readonly kind: 'pages-data'; readonly entry: RouteEntry }
  | { readonly kind: 'action' }
  | { readonly kind: 'passthrough'; readonly reason: PassthroughReason };

export interface ClassifyInput {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly manifest: ProjectManifest | undefined;
  readonly deployment: DeploymentFingerprint | undefined;
}
