import { pageDataArtifact } from '@stayingupwind/core/bundle';
import {
  decodeGenerationPack,
  kvGenerationKey,
  staticPageDataHeadersAllowSharing,
  type DecodedGenerationPack,
} from '@stayingupwind/core/cache';
import {
  CACHE_ENTRY_HEADER,
  CACHE_ROUTE_HEADER,
  CACHE_ROUTE_ESCAPED_HEADER,
  pathHeaders,
  REGENERATE_HEADER,
} from '@stayingupwind/core/paas';
import { SHARED_CACHE_CONTROL_HEADERS } from '@stayingupwind/core/request';
import { TtlCache, withDeadline } from '@stayingupwind/core/util';
import type { RuntimeCacheSettings } from '@stayingupwind/host/delivery';

import { claimBackgroundRecord } from '../cache/background-record-budget.ts';
import { condemnedIn } from '../cache/condemned.ts';
import { decideGeneration, type GenerationDecision } from '../cache/decision.ts';
import { adoptDecoded, type Read } from '../cache/generation-loader.ts';
import { regenerationHeaders } from '../cache/regenerate.ts';
import type { EdgeMemory } from '../memory/caches.ts';
import { handlePassthrough } from './passthrough.ts';
import type { StaticPageInput } from './static-page.ts';

const KIB = 1024;
const MAX_RECORD_MIB = 4;
const MAX_RECORD_BYTES = MAX_RECORD_MIB * KIB * KIB;
const HTTP_OK = 200;
const CURRENT_RECORD_READ_MS = 1000;
/** After the Function's own publication wait, independently verify its authoritative pair. */
const FOREGROUND_RECORD_READ_MS = 10_000;
const MAX_FOREGROUND_READS = 2;
const MAX_FIRST_MEMBER_READS = 6;
const FIRST_MEMBER_RETRY_MS = 250;
const MAX_MISSING_READS = 1024;
const missingReads = new WeakMap<EdgeMemory, TtlCache<string, true>>();
const foregroundReads = new WeakMap<EdgeMemory, Set<string>>();

interface CurrentRead {
  active: boolean;
  absent: boolean;
  reads: number;
  readonly signal?: AbortSignal;
  readonly until?: number;
}

interface CaptureRead {
  readonly scopeId: string;
  readonly state: CurrentRead;
  readonly previous: DecodedGenerationPack | undefined;
  readonly confirmUntil?: number;
}

const noDispatches = (): number => 0;

/** Foreground proof must not compete with optional background refreshes. */
function claimForegroundRecord(memory: EdgeMemory, key: string): (() => void) | undefined {
  let pending = foregroundReads.get(memory);
  if (pending === undefined) {
    pending = new Set();
    foregroundReads.set(memory, pending);
  }
  if (pending.has(key) || pending.size >= MAX_FOREGROUND_READS) return undefined;
  pending.add(key);
  return () => {
    pending.delete(key);
  };
}

function stillActive(state: CurrentRead): boolean {
  return (
    state.active &&
    state.signal?.aborted !== true &&
    (state.until === undefined || performance.now() < state.until)
  );
}

async function settled(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch {
    // Publication failure keeps the untouched private Function response.
  }
}

async function readWithRelease(
  input: StaticPageInput,
  context: CaptureRead,
  release: () => void,
): Promise<Extract<GenerationDecision, { kind: 'serve' }> | undefined> {
  try {
    return await confirmedPairedPage(input, context);
  } finally {
    release();
  }
}

/** Only a first lazy JSON may rendezvous with a different Function's outstanding publication. */
async function confirmedPairedPage(
  input: StaticPageInput,
  context: CaptureRead,
): Promise<Extract<GenerationDecision, { kind: 'serve' }> | undefined> {
  let decision = await currentPairedPage(input, context);
  let delay = FIRST_MEMBER_RETRY_MS;
  const { state, confirmUntil } = context;
  if (confirmUntil === undefined) return decision;
  while (stillActive(state) && state.absent && state.reads < MAX_FIRST_MEMBER_READS) {
    const remaining = confirmUntil - performance.now();
    if (remaining <= 0) break;
    await pause(Math.min(delay, remaining), state.signal);
    if (!stillActive(state) || performance.now() >= confirmUntil) break;
    decision = await currentPairedPage(input, context);
    delay *= 2;
  }
  return decision;
}

function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted === true) finish();
  });
}

function pairedRecord(bytes: ArrayBuffer, input: StaticPageInput, scopeId: string) {
  const decoded = decodeGenerationPack(new Uint8Array(bytes));
  return decoded.kind === 'ok' && pageDataArtifact(decoded.pack, input.entry, scopeId) !== undefined
    ? decoded
    : undefined;
}

function responseAllowsAdoption(response: Response): boolean {
  // Passthrough adds its own private policy; every remaining application veto still applies.
  return staticPageDataHeadersAllowSharing(
    [...response.headers].filter(
      ([name]) => name !== 'cache-control' && !SHARED_CACHE_CONTROL_HEADERS.includes(name),
    ),
  );
}

async function currentPairedPage(
  input: StaticPageInput,
  context: CaptureRead,
): Promise<Extract<GenerationDecision, { kind: 'serve' }> | undefined> {
  if (!stillActive(context.state)) return undefined;
  const { edge, entry } = input;
  const { scopeId, state, previous } = context;
  const startedAt = edge.runtime.now();
  const key = { scopeId, entryId: entry.entryId };
  const recordKey = kvGenerationKey(scopeId, entry.entryId);
  const heldAtStart = edge.runtime.memory.generations.get(recordKey);
  state.reads += 1;
  const bytes = await edge.host.currentRecord?.(
    scopeId,
    entry.entryId,
    previous?.header.revision ?? 0,
  );
  state.absent = bytes === undefined;
  if (bytes === undefined || !stillActive(state) || bytes.byteLength > MAX_RECORD_BYTES)
    return undefined;
  const decoded = pairedRecord(bytes, input, scopeId);
  if (decoded === undefined) return undefined;
  if (!replacesPrevious(decoded.pack, previous)) return undefined;
  const read: Read = {
    key,
    recordKey,
    options: {},
    startedAt,
    copies: false,
    heldRevision: heldAtStart?.pack.header.revision,
    heldAtStart,
    adopted: { held: undefined },
  };
  const adoption = await adoptDecoded(edge, read, decoded, {
    origin: { kind: 'authority' },
    byteLength: bytes.byteLength,
    wanted: () => stillActive(state),
  });
  if (adoption.kind === 'unusable' || !stillActive(state)) return undefined;
  const pack = adoption.kind === 'behind' ? adoption.held.pack : adoption.pack;
  if (pageDataArtifact(pack, entry, scopeId) === undefined || !replacesPrevious(pack, previous))
    return undefined;
  const decision = decideGeneration(
    { kind: 'generation', pack, source: 'memory', lookupMs: edge.runtime.now() - startedAt },
    edge.runtime.now(),
    condemnedIn(edge.runtime.memory, edge.app?.deploymentId),
    input.manifest.publication,
  );
  return decision.kind === 'serve' &&
    decision.validity === 'fresh' &&
    pack.header.invalidation === undefined
    ? { ...decision, source: 'authority' }
    : undefined;
}

function replacesPrevious(
  pack: DecodedGenerationPack,
  previous: DecodedGenerationPack | undefined,
): boolean {
  return (
    previous === undefined ||
    (pack.header.revision > previous.header.revision &&
      pack.header.seq > previous.header.seq &&
      pack.header.generationId !== previous.header.generationId)
  );
}

/** A loading response never waits for this read, including while KV still holds an absence. */
export function refreshMissingPairedPage(
  input: StaticPageInput,
  settings: RuntimeCacheSettings,
): void {
  const { edge, entry } = input;
  const scopeId = input.manifest.cache?.scopeId;
  if (
    scopeId === undefined ||
    edge.validated ||
    settings.holdMs === 0 ||
    edge.host.currentRecord === undefined
  )
    return;
  const recordKey = kvGenerationKey(scopeId, entry.entryId);
  let recent = missingReads.get(edge.runtime.memory);
  if (recent === undefined) {
    recent = new TtlCache(CURRENT_RECORD_READ_MS, MAX_MISSING_READS, edge.runtime.now);
    missingReads.set(edge.runtime.memory, recent);
  }
  if (recent.get(recordKey) !== undefined) return;
  const release = claimBackgroundRecord(edge.runtime, recordKey);
  if (release === undefined) return;
  recent.set(recordKey, true);
  const state = { active: true, absent: false, reads: 0 };
  const operation = (async () => {
    // Dispatch only after the loading response has been selected; fresh hits never call here.
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
    return readWithRelease(input, { scopeId, state, previous: undefined }, release);
  })();
  edge.ctx.waitUntil(
    (async (): Promise<void> => {
      try {
        await withDeadline(operation, CURRENT_RECORD_READ_MS, 'first Pages member record');
      } catch {
        // An unavailable or late record leaves loading delivery unchanged until a later read.
      } finally {
        state.active = false;
      }
    })(),
  );
}

/** Only a cold/expired paired-data request waits for publication; its private body stays intact. */
export async function capturePairedPageData(
  input: StaticPageInput,
  previous?: DecodedGenerationPack,
  firstMember = false,
): Promise<{
  readonly response: Response;
  readonly decision: Extract<GenerationDecision, { kind: 'serve' }> | undefined;
  readonly dispatches: number;
  readonly authorityReads: number;
}> {
  const { edge, entry, manifest } = input;
  const scopeId = manifest.cache?.scopeId;
  if (scopeId === undefined) throw new Error('paired Pages capture needs its deployment scope');
  let dispatches = noDispatches;
  const headers =
    previous === undefined
      ? {
          [REGENERATE_HEADER]: 'foreground',
          [CACHE_ENTRY_HEADER]: entry.entryId,
          ...pathHeaders(CACHE_ROUTE_HEADER, CACHE_ROUTE_ESCAPED_HEADER, entry.route),
        }
      : regenerationHeaders(edge, 'foreground', { pack: previous, entryId: entry.entryId });
  const response = await handlePassthrough({
    request: new Request(input.request, { signal: null }),
    forwarding: edge.forwarding,
    runtime: edge.runtime,
    host: edge.host,
    app: edge.app,
    cspReportingPath: edge.cspReportingPath,
    function: entry.function,
    scopeId,
    reason: 'pages-data-capture',
    privateDelivery: edge.privateDelivery,
    headers,
    whenGone: edge.whenGone,
    onAsked: (read) => {
      dispatches = read;
    },
  });
  if (response.status !== HTTP_OK || !responseAllowsAdoption(response))
    return { response, decision: undefined, dispatches: dispatches(), authorityReads: 0 };
  if (firstMember && previous === undefined && input.request.signal.aborted)
    return { response, decision: undefined, dispatches: dispatches(), authorityReads: 0 };
  const release = claimForegroundRecord(
    edge.runtime.memory,
    kvGenerationKey(scopeId, entry.entryId),
  );
  if (release === undefined)
    return { response, decision: undefined, dispatches: dispatches(), authorityReads: 0 };
  const until = performance.now() + FOREGROUND_RECORD_READ_MS;
  const state: CurrentRead = {
    active: true,
    absent: false,
    reads: 0,
    ...(firstMember && previous === undefined && { signal: input.request.signal, until }),
  };
  const operation = readWithRelease(
    input,
    {
      scopeId,
      state,
      previous,
      ...(firstMember &&
        previous === undefined &&
        edge.host.currentRecord !== undefined && {
          confirmUntil: until,
        }),
    },
    release,
  );
  // A timed-out host RPC holds its slot until it actually settles, and can never adopt late bytes.
  edge.ctx.waitUntil(settled(operation));
  try {
    return {
      response,
      decision: await withDeadline(
        operation,
        Math.max(0, until - performance.now()),
        'paired Pages record',
      ),
      dispatches: dispatches(),
      authorityReads: state.reads,
    };
  } catch {
    return { response, decision: undefined, dispatches: dispatches(), authorityReads: state.reads };
  } finally {
    state.active = false;
  }
}
