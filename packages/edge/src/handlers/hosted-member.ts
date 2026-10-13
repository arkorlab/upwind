import {
  isReserved,
  memberEntryPathname,
  type MemberOfClass,
  memberRouteFor,
  type ProjectManifest,
} from '@stayingupwind/core/manifest';
import { type RequestClass, wantsBlockingMetadata } from '@stayingupwind/core/request';
import { type ResolvedPolicy, runtimeCacheOf } from '@stayingupwind/host/delivery';

import { serveCachedDocument } from '../cache/document.ts';
import { ownRecordEntry, startMemberRead } from '../cache/member.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { composePayload } from './hosted-parts.ts';
import { bypassed, offTheEdge, requestAsLeft } from './hosted-route.ts';
import type { MiddlewareOutcome } from './middleware.ts';
import type { PassthroughWait } from './passthrough.ts';

/**
 * A member of a class the build made no shell of, from its own record: the one the member's first
 * render left, which the Worker answers it from otherwise. Where there is none to serve — none yet,
 * none the edge can read — the request goes on to the Worker as it did before (`Unserved`), which
 * renders the member and leaves the record a later request finds.
 *
 * Under the class's name, as a class shell's members are counted, condemned and demoted. Read once
 * the middleware has settled the route, as a member's own record beside a class shell is, and then
 * from this isolate's memory, where the record or its absence is held (`startMemberRead`).
 */

/** A navigation whose pathname names no route the build proved: the middleware may still find one. */
const ROUTE_NOT_PROVED = 'route-not-proved';
const USER_AGENT_HEADER = 'user-agent';
const RSC_PAYLOAD = 'rsc-payload';

/** What a document request of a hosted application brings to serving a member of such a class. */
export interface MemberInput {
  readonly request: Request<unknown, IncomingRequestCfProperties>;
  readonly url: URL;
  readonly edge: EdgeContext;
  readonly manifest: ProjectManifest;
  readonly resolved: ResolvedPolicy<EdgeContext>;
  readonly classification: RequestClass;
  readonly passthrough: (
    reason: string,
    middleware?: MiddlewareOutcome,
    route?: string,
    waited?: PassthroughWait,
  ) => Promise<Response>;
}

/**
 * The request handed to the Worker as it would have been with no member to look for: counted under
 * `route`, the class's, where one was found, and with what reading its record took.
 */
export type Unserved = (route?: string, waited?: PassthroughWait) => Promise<Response>;

/**
 * The class the request as the middleware left it is a member of, where the build made no shell of
 * the class and its members are served from records (`memberRouteFor`): asked of a navigation — one
 * that named no proved route, or was rewritten off the one it named — of a deployment with a runtime
 * cache whose policy serves from records. A validation request proves the build's shells and reads
 * no record. Whole Flight can use the same member record; segment prefetches remain the Worker's.
 */
function memberOf(input: MemberInput, middleware: MiddlewareOutcome): MemberOfClass | undefined {
  const { manifest, classification, edge } = input;
  const navigation =
    classification.kind === 'document' ||
    classification.kind === RSC_PAYLOAD ||
    (classification.kind === 'passthrough' && classification.reason === ROUTE_NOT_PROVED);
  if (
    !navigation ||
    manifest.cache === undefined ||
    edge.validated ||
    runtimeCacheOf(edge.policy).generations !== 'on'
  ) {
    return undefined;
  }
  const left = requestAsLeft(input, middleware);
  // Behind the gate a rewrite's target passes on its way to a route (`hostedEntry`): a rule ahead
  // of the filesystem claims it first.
  const rewritten = middleware.kind === 'continue' && middleware.rewritten;
  if (rewritten && isReserved(manifest, left.url, left.headers, true)) {
    return undefined;
  }
  const member = memberRouteFor(manifest, left.url, left.headers);
  return classification.kind === RSC_PAYLOAD && member?.members.kind !== 'app-page'
    ? undefined
    : member;
}

/**
 * Serve the member of a class with no shell the request is for, unless it is off the edge or
 * Next.js would not serve it a prerender; `undefined` where the request is for none.
 */
export function serveMemberWithoutShell(
  input: MemberInput,
  middleware: MiddlewareOutcome,
  unserved: Unserved,
): Promise<Response> | undefined {
  const member = memberOf(input, middleware);
  const scopeId = input.manifest.cache?.scopeId;
  if (member === undefined || scopeId === undefined) {
    return undefined;
  }
  const { edge, manifest } = input;
  const left = requestAsLeft(input, middleware);
  const named = ownRecordEntry(member);
  const off = offTheEdge(edge, named);
  if (off !== undefined) {
    return input.passthrough(off, middleware, named.pathname);
  }
  // The class's own conditions, and the crawlers Next.js renders a page whole for, of the agent the
  // request reaches the route with: the classification asked the list of the one it came with, and
  // a member's conditions leave that out (`MemberRoute`), but a middleware may change the agent.
  if (
    bypassed(manifest, named, left.url, left.headers) ||
    wantsBlockingMetadata(left.headers.get(USER_AGENT_HEADER), manifest)
  ) {
    return input.passthrough('bypass-for', middleware, named.pathname);
  }
  const found = { member, scopeId, pathname: left.url.pathname };
  return serveOwnRecord(input, found, middleware, (waited) => unserved(named.pathname, waited));
}

/** The member: its class, the scope its record is kept in, and its pathname as the request asks. */
interface FoundMember {
  readonly member: MemberOfClass;
  readonly scopeId: string;
  readonly pathname: string;
}

async function serveOwnRecord(
  input: MemberInput,
  { member, scopeId, pathname }: FoundMember,
  middleware: MiddlewareOutcome,
  unserved: (waited?: PassthroughWait) => Promise<Response>,
): Promise<Response> {
  const { edge } = input;
  const settings = runtimeCacheOf(edge.policy);
  const { route, kind } = member.members;
  // Kept under the shell the member completes to where its class's entries are keyed by some of
  // the route's parameters (Next.js 16.4): every member that shares them is served the one record,
  // resumed for its own pathname.
  const keyed = memberEntryPathname(member.members, pathname);
  const read = startMemberRead(edge, settings, { scopeId, route, kind, pathname: keyed });
  const loaded = read.held ?? (await read.pending);
  if (loaded === undefined) {
    return unserved();
  }
  if (input.classification.kind === RSC_PAYLOAD) {
    return composePayload(
      {
        ...input,
        passthrough: () => unserved({ recordLookupMs: loaded.load.lookupMs }),
      },
      ownRecordEntry(member, loaded.key.entryId),
      middleware,
      { held: loaded.load, keyed: member.members.keyedBy !== undefined },
    );
  }
  return serveCachedDocument({
    request: input.request,
    entry: ownRecordEntry(member, loaded.key.entryId),
    manifest: input.manifest,
    resolved: input.resolved,
    edge,
    middleware:
      middleware.kind === 'continue' || middleware.kind === 'skipped' ? middleware : undefined,
    passthrough: input.passthrough,
    key: loaded.key,
    settings,
    generationRead: { load: Promise.resolve(loaded.load), shell: undefined },
    member: undefined,
    noBuild: (recordLookupMs) => unserved({ recordLookupMs }),
    keyed: member.members.keyedBy !== undefined,
  });
}
