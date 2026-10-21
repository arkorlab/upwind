import type { Want } from './answers.ts';

export interface GenerationSource extends Want {
  readonly route: string;
  /** The entry's pathname: as the seed keyed it, or the member asked for when the build made none. */
  readonly pathname: string;
  /** A page's data route, which the build's generation of the data is read under. */
  readonly dataPathname?: string | undefined;
  /** A version3 Pages loading shell answers a cold HTML visit before its member is generated. */
  readonly pagesFallback?: boolean | undefined;
  /**
   * Without a record: the build's own output answers (`build`), or the entry is rendered now and
   * kept (`render`) — a member of a route the build left to the first request for it — or the
   * build's output answers and the entry is rendered behind it, for the requests after (`behind`):
   * a prefetch of such a member, which a deployment of Next.js answers from the class's own output
   * while it renders the member's, and which is not kept waiting on a render it may never use.
   */
  readonly onMiss: 'build' | 'render' | 'behind';
}
