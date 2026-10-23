import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

import {
  decodeGenerationPack,
  type DecodedGenerationPack,
  encodeGenerationPack,
  kvGenerationKey,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import { encodeUtf8 } from '@stayingupwind/core/util';
import { IsolateBudget, SharedByteLru } from '@stayingupwind/edge/internal/memory/budget.ts';
import { RECOVERY_SCRIPT_CSP_SOURCE } from '@stayingupwind/host/splice';
import { describe, expect, it } from 'vitest';

import { GenerationEvidence, watchedGenerationMemory } from '../src/workers/generation-evidence.ts';
import type { RecordedGeneration } from '../src/workers/protocol.ts';

const SCOPE = 'scope_local_evidence';
const NOW = 1_800_000_000_000;
const HTML = encodeUtf8('<html><body>the record</body></html>');
const POSTPONED = encodeUtf8('postponed');
const HTML_HASH = createHash('sha256').update(HTML).digest('hex');
const POSTPONED_HASH = createHash('sha256').update(POSTPONED).digest('hex');
const RESTRICTIVE = "default-src 'self'; script-src 'none'; frame-ancestors 'none'";

function packet(
  entryId: string,
  seq: number,
  headers: Readonly<Record<string, string>>,
  partial: boolean,
): ArrayBuffer {
  const bytes = encodeGenerationPack(
    {
      schemaVersion: 1,
      scopeId: SCOPE,
      entryId,
      generationId: `gen_${entryId}_${String(seq)}`,
      seq,
      revision: seq,
      source: 'runtime',
      kind: 'app-page',
      route: '/',
      pathname: '/',
      cacheTimestamp: NOW,
      producedAt: NOW,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers,
      tags: [],
      htmlSha256: HTML_HASH,
      htmlLength: HTML.byteLength,
      postponedSha256: partial ? POSTPONED_HASH : null,
      postponedLength: partial ? POSTPONED.byteLength : 0,
      artifacts: [],
    },
    HTML,
    partial ? POSTPONED : undefined,
  );
  return new Uint8Array(bytes).buffer;
}

function observed(
  generations: GenerationEvidence,
  entry: string,
  seq: number,
): RecordedGeneration | undefined {
  return generations.snapshot('trace')[`${kvGenerationKey(SCOPE, entry)}|${String(seq)}`];
}

function heldPacket(entry: string, seq: number): { readonly pack: DecodedGenerationPack } {
  const bytes = packet(entry, seq, { 'x-render': String(seq) }, false);
  const decoded = decodeGenerationPack(new Uint8Array(bytes));
  if (decoded.kind !== 'ok') throw new TypeError('the test record must decode');
  return { pack: decoded.pack };
}

function memoryFor(bytes: number): SharedByteLru<{ readonly pack: DecodedGenerationPack }> {
  return new SharedByteLru<{ readonly pack: DecodedGenerationPack }>(new IsolateBudget(bytes));
}

/** The Worker uses the same callback on its persistent memory wrapper. */
function scopedMemory(
  memory: ReturnType<typeof memoryFor>,
  evidence: GenerationEvidence,
  requestTrace: AsyncLocalStorage<string>,
) {
  return watchedGenerationMemory(memory, (key, pack) => {
    evidence.held(requestTrace.getStore(), key, pack);
  });
}

describe('generation evidence kept by the local edge Worker', () => {
  it('permits the same recovery script as a resumable generation while preserving other headers', () => {
    const generations = new GenerationEvidence(256);
    generations.begin('trace');
    const headers = { 'content-security-policy': RESTRICTIVE, 'x-recorded': 'preserved' };
    generations.observe(
      'trace',
      kvGenerationKey(SCOPE, 'entry_partial'),
      packet('entry_partial', 2, headers, true),
    );
    const kept = observed(generations, 'entry_partial', 2);

    expect(kept?.headers['content-security-policy']).toContain(RECOVERY_SCRIPT_CSP_SOURCE);
    expect(kept?.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(kept?.headers['x-recorded']).toBe('preserved');
    expect(kept?.partial).toBe(true);
    expect(headers['content-security-policy']).toBe(RESTRICTIVE);
  });

  it('keeps a complete generation policy exactly as recorded', () => {
    const generations = new GenerationEvidence(256);
    generations.begin('trace');
    const headers = { 'content-security-policy': RESTRICTIVE, 'x-recorded': 'complete' };
    generations.observe(
      'trace',
      kvGenerationKey(SCOPE, 'entry_complete'),
      packet('entry_complete', 2, headers, false),
    );

    expect(observed(generations, 'entry_complete', 2)?.headers).toStrictEqual(headers);
    expect(observed(generations, 'entry_complete', 2)?.partial).toBe(false);
  });

  it('does not add a policy to a partial generation that recorded none', () => {
    const generations = new GenerationEvidence(256);
    generations.begin('trace');
    const headers = { 'content-type': 'text/html', 'x-recorded': 'no policy' };
    generations.observe(
      'trace',
      kvGenerationKey(SCOPE, 'entry_no_policy'),
      packet('entry_no_policy', 2, headers, true),
    );

    expect(observed(generations, 'entry_no_policy', 2)?.headers).toStrictEqual(headers);
  });

  it('retains the first observed record after more than 1024 other entries without reading it again', () => {
    const generations = new GenerationEvidence(256);
    generations.begin('trace');
    const firstKey = kvGenerationKey(SCOPE, 'entry_first');
    generations.observe(
      'trace',
      firstKey,
      packet('entry_first', 2, { 'x-render': 'first' }, false),
    );
    for (let index = 0; index < 1025; index++) {
      const entry = `entry_${String(index)}`;
      generations.observe(
        'trace',
        kvGenerationKey(SCOPE, entry),
        packet(entry, 2, { 'x-render': entry }, false),
      );
    }

    expect(observed(generations, 'entry_first', 2)).toMatchObject({
      headers: { 'x-render': 'first' },
      artifacts: [],
      partial: false,
      source: 'runtime',
      freshness: { cacheTimestamp: NOW },
    });
    expect(observed(generations, 'entry_1024', 2)?.headers['x-render']).toBe('entry_1024');
  });

  it('keeps distinct sequences available instead of replacing a generation still being checked', () => {
    const generations = new GenerationEvidence(256);
    generations.begin('trace');
    const key = kvGenerationKey(SCOPE, 'entry_history');
    generations.observe('trace', key, packet('entry_history', 2, { 'x-render': 'old' }, false));
    generations.observe('trace', key, packet('entry_history', 3, { 'x-render': 'new' }, false));

    expect(observed(generations, 'entry_history', 2)?.headers['x-render']).toBe('old');
    expect(observed(generations, 'entry_history', 3)?.headers['x-render']).toBe('new');
  });

  it('does not replace an observation with missing or malformed non-record values', () => {
    const generations = new GenerationEvidence(256);
    generations.begin('trace');
    const key = kvGenerationKey(SCOPE, 'entry_valid');
    generations.observe('trace', key, packet('entry_valid', 2, { 'x-render': 'valid' }, false));
    const before = observed(generations, 'entry_valid', 2);
    generations.observe('trace', key, null);
    generations.observe('trace', key, 'not a record');
    generations.observe('trace', key, new ArrayBuffer(1));

    expect(observed(generations, 'entry_valid', 2)).toBe(before);
    expect(Object.keys(generations.snapshot('trace'))).toHaveLength(1);
  });

  it('keeps no trace evidence for ordinary serve observations or callbacks after disposal', () => {
    const evidence = new GenerationEvidence(256);
    const key = kvGenerationKey(SCOPE, 'entry_untraced');
    const value = packet('entry_untraced', 2, { 'x-render': 'untraced' }, false);
    for (let index = 0; index < 1025; index++) {
      evidence.observe('owned', `${key}_${String(index)}`, value);
    }
    evidence.begin('owned');
    evidence.observe('owned', key, value);
    const captured = evidence.snapshot('owned');
    evidence.forget('owned');
    evidence.observe('owned', key, value);

    expect(evidence.snapshot('unregistered')).toStrictEqual({});
    expect(evidence.snapshot('owned')).toStrictEqual({});
    expect(evidence.forRecord([], key)).toStrictEqual({});
    expect(captured[`${key}|2`]?.headers['x-render']).toBe('untraced');
  });

  it('reads untraced prewarming from the actual cache beyond 1024 entries without a shadow map', () => {
    const evidence = new GenerationEvidence(256);
    const memory = memoryFor(4 * 1024 * 1024);
    const firstKey = kvGenerationKey(SCOPE, 'entry_first');
    const first = heldPacket('entry_first', 2);
    memory.set(firstKey, first, 1024);
    for (let index = 0; index < 1025; index++) {
      const entry = `entry_${String(index)}`;
      memory.set(kvGenerationKey(SCOPE, entry), heldPacket(entry, 2), 1024);
    }
    const read = evidence.forRecord(memory.values(), firstKey);

    expect(memory.get(firstKey)).toBe(first);
    expect(read['2']?.headers['x-render']).toBe('2');
    expect(evidence.snapshot('not-a-trace')).toStrictEqual({});
  });

  it('lets actual cache eviction release untraced evidence and does not touch its LRU order', () => {
    const evidence = new GenerationEvidence(256);
    const memory = memoryFor(2048);
    const firstKey = kvGenerationKey(SCOPE, 'entry_first');
    memory.set(firstKey, heldPacket('entry_first', 2), 1024);
    memory.set(kvGenerationKey(SCOPE, 'entry_second'), heldPacket('entry_second', 2), 1024);
    const before = evidence.forRecord(memory.values(), firstKey);
    memory.set(kvGenerationKey(SCOPE, 'entry_third'), heldPacket('entry_third', 2), 1024);

    expect(before['2']?.headers['x-render']).toBe('2');
    expect(memory.get(firstKey)).toBeUndefined();
    expect(evidence.forRecord(memory.values(), firstKey)).toStrictEqual({});
  });

  it('captures a memory hit before a background replacement and keeps the snapshot after DELETE', () => {
    const evidence = new GenerationEvidence(256);
    const memory = memoryFor(4096);
    const key = kvGenerationKey(SCOPE, 'entry_history');
    const first = heldPacket('entry_history', 2);
    memory.set(key, first, 1024);
    evidence.begin('trace');
    const watched = watchedGenerationMemory(memory, (at, pack) => {
      evidence.held('trace', at, pack);
    });
    const hit = watched.get(key);
    watched.set(key, heldPacket('entry_history', 3), 1024);
    const captured = evidence.snapshot('trace');
    evidence.forget('trace');

    expect(hit).toBe(first);
    expect([...watched.values()]).toHaveLength(1);
    expect(watched.usedBytes).toBe(1024);
    expect(captured[`${key}|2`]?.headers['x-render']).toBe('2');
    expect(captured[`${key}|3`]?.headers['x-render']).toBe('3');
    expect(evidence.forRecord(memory.values(), key)['2']).toBeUndefined();
    expect(evidence.snapshot('trace')).toStrictEqual({});
  });

  it('releases overflowed trace owners while current checks retain observations', () => {
    const evidence = new GenerationEvidence(256);
    const key = kvGenerationKey(SCOPE, 'entry_history');
    evidence.begin('first');
    evidence.held('first', key, heldPacket('entry_history', 2).pack);
    for (let index = 0; index < 256; index++) {
      evidence.begin(`trace_${String(index)}`);
    }
    evidence.held('trace_255', key, heldPacket('entry_history', 3).pack);

    expect(evidence.snapshot('first')).toStrictEqual({});
    expect(evidence.snapshot('trace_255')[`${key}|3`]?.headers['x-render']).toBe('3');
  });

  it('keeps each active request separate and releases both owners after disposal', () => {
    const evidence = new GenerationEvidence(256);
    const key = kvGenerationKey(SCOPE, 'entry_shared');
    const value = packet('entry_shared', 2, { 'x-render': 'shared' }, false);
    evidence.observe(undefined, key, value);
    evidence.begin('first');
    evidence.begin('second');
    evidence.observe('first', key, value);
    const first = evidence.snapshot('first');
    const second = evidence.snapshot('second');
    evidence.forget('first');
    evidence.forget('second');
    evidence.observe('first', key, value);

    expect(first[`${key}|2`]?.headers['x-render']).toBe('shared');
    expect(second).toStrictEqual({});
    expect(evidence.snapshot('first')).toStrictEqual({});
    expect(evidence.snapshot('second')).toStrictEqual({});
    expect(evidence.forRecord([], key)).toStrictEqual({});
    expect(Object.hasOwn(first[`${key}|2`] ?? {}, 'pack')).toBe(false);
  });

  it('attributes interleaved memory hits and adoptions only to their asynchronous request', async () => {
    const evidence = new GenerationEvidence(256);
    const requestTrace = new AsyncLocalStorage<string>();
    const memory = memoryFor(4096);
    const firstKey = kvGenerationKey(SCOPE, 'entry_first');
    const secondKey = kvGenerationKey(SCOPE, 'entry_second');
    memory.set(firstKey, heldPacket('entry_first', 2), 1024);
    const watched = scopedMemory(memory, evidence, requestTrace);
    const firstRead = Promise.withResolvers<true>();
    const secondRead = Promise.withResolvers<true>();
    evidence.begin('first');
    evidence.begin('second');
    const first = requestTrace.run('first', async () => {
      watched.get(firstKey);
      firstRead.resolve(true);
      await secondRead.promise;
      watched.get(firstKey);
    });
    const second = requestTrace.run('second', async () => {
      await firstRead.promise;
      watched.set(secondKey, heldPacket('entry_second', 3), 1024);
      secondRead.resolve(true);
    });
    await Promise.all([first, second]);
    // The persistent wrapper also serves ordinary traffic, which belongs to neither trace.
    watched.set(kvGenerationKey(SCOPE, 'entry_ordinary'), heldPacket('entry_ordinary', 4), 1024);
    const firstSnapshot = evidence.snapshot('first');
    const secondSnapshot = evidence.snapshot('second');

    expect(Object.keys(firstSnapshot)).toStrictEqual([`${firstKey}|2`]);
    expect(Object.keys(secondSnapshot)).toStrictEqual([`${secondKey}|3`]);
    expect(firstSnapshot[`${firstKey}|2`]?.headers['x-render']).toBe('2');
    expect(secondSnapshot[`${secondKey}|3`]?.headers['x-render']).toBe('3');
    expect(requestTrace.getStore()).toBeUndefined();
  });

  it('excludes concurrent KV and authority reads belonging to a different or untraced request', async () => {
    const evidence = new GenerationEvidence(256);
    const key = kvGenerationKey(SCOPE, 'entry_request');
    const otherKey = kvGenerationKey(SCOPE, 'entry_authority');
    const otherRead = Promise.withResolvers<true>();
    evidence.begin('first');
    evidence.begin('second');
    const first = async () => {
      await otherRead.promise;
      evidence.observe('first', key, packet('entry_request', 2, { 'x-render': 'own' }, false));
    };
    const pending = first();
    evidence.observe('second', key, packet('entry_request', 3, { 'x-render': 'foreign' }, false));
    evidence.held('second', otherKey, heldPacket('entry_authority', 4).pack);
    evidence.observe(undefined, key, packet('entry_request', 5, { 'x-render': 'ordinary' }, false));
    otherRead.resolve(true);
    await pending;
    const captured = evidence.snapshot('first');
    evidence.seal('first');
    evidence.observe('first', key, packet('entry_request', 6, { 'x-render': 'late' }, false));

    expect(Object.keys(captured)).toStrictEqual([`${key}|2`]);
    expect(captured[`${key}|2`]?.headers['x-render']).toBe('own');
    expect(Object.keys(evidence.snapshot('second'))).toStrictEqual([`${key}|3`, `${otherKey}|4`]);
    expect(evidence.snapshot('first')).toStrictEqual(captured);
    expect(evidence.forRecord([], key)).toStrictEqual({});
  });

  it('freezes a completed response snapshot even when its DELETE never arrives', () => {
    const evidence = new GenerationEvidence(256);
    const key = kvGenerationKey(SCOPE, 'entry_sealed');
    evidence.begin('unfinished-client');
    evidence.held('unfinished-client', key, heldPacket('entry_sealed', 2).pack);
    evidence.seal('unfinished-client');
    const captured = evidence.snapshot('unfinished-client');
    for (let index = 0; index < 1025; index++) {
      const entry = `entry_later_${String(index)}`;
      evidence.held('unfinished-client', kvGenerationKey(SCOPE, entry), heldPacket(entry, 3).pack);
    }

    expect(evidence.snapshot('unfinished-client')).toStrictEqual(captured);
    expect(Object.keys(captured)).toHaveLength(1);
    expect(captured[`${key}|2`]?.headers['x-render']).toBe('2');
  });
});
