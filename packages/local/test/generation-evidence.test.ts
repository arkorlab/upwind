import { createHash } from 'node:crypto';

import { encodeGenerationPack, kvGenerationKey, policyFromBuild } from '@stayingupwind/core/cache';
import { encodeUtf8 } from '@stayingupwind/core/util';
import { RECOVERY_SCRIPT_CSP_SOURCE } from '@stayingupwind/host/splice';
import { describe, expect, it } from 'vitest';

import { rememberGeneration } from '../src/workers/generation-evidence.ts';
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
  generations: ReadonlyMap<string, RecordedGeneration>,
  entry: string,
  seq: number,
): RecordedGeneration | undefined {
  return generations.get(`${kvGenerationKey(SCOPE, entry)}|${String(seq)}`);
}

describe('generation evidence kept by the local edge Worker', () => {
  it('permits the same recovery script as a resumable generation while preserving other headers', () => {
    const generations = new Map<string, RecordedGeneration>();
    const headers = { 'content-security-policy': RESTRICTIVE, 'x-recorded': 'preserved' };
    rememberGeneration(
      generations,
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
    const generations = new Map<string, RecordedGeneration>();
    const headers = { 'content-security-policy': RESTRICTIVE, 'x-recorded': 'complete' };
    rememberGeneration(
      generations,
      kvGenerationKey(SCOPE, 'entry_complete'),
      packet('entry_complete', 2, headers, false),
    );

    expect(observed(generations, 'entry_complete', 2)?.headers).toStrictEqual(headers);
    expect(observed(generations, 'entry_complete', 2)?.partial).toBe(false);
  });

  it('does not add a policy to a partial generation that recorded none', () => {
    const generations = new Map<string, RecordedGeneration>();
    const headers = { 'content-type': 'text/html', 'x-recorded': 'no policy' };
    rememberGeneration(
      generations,
      kvGenerationKey(SCOPE, 'entry_no_policy'),
      packet('entry_no_policy', 2, headers, true),
    );

    expect(observed(generations, 'entry_no_policy', 2)?.headers).toStrictEqual(headers);
  });

  it('retains the first observed record after more than 1024 other entries without reading it again', () => {
    const generations = new Map<string, RecordedGeneration>();
    const firstKey = kvGenerationKey(SCOPE, 'entry_first');
    rememberGeneration(
      generations,
      firstKey,
      packet('entry_first', 2, { 'x-render': 'first' }, false),
    );
    for (let index = 0; index < 1025; index++) {
      const entry = `entry_${String(index)}`;
      rememberGeneration(
        generations,
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
    const generations = new Map<string, RecordedGeneration>();
    const key = kvGenerationKey(SCOPE, 'entry_history');
    rememberGeneration(generations, key, packet('entry_history', 2, { 'x-render': 'old' }, false));
    rememberGeneration(generations, key, packet('entry_history', 3, { 'x-render': 'new' }, false));

    expect(observed(generations, 'entry_history', 2)?.headers['x-render']).toBe('old');
    expect(observed(generations, 'entry_history', 3)?.headers['x-render']).toBe('new');
  });

  it('does not replace an observation with missing or malformed non-record values', () => {
    const generations = new Map<string, RecordedGeneration>();
    const key = kvGenerationKey(SCOPE, 'entry_valid');
    rememberGeneration(generations, key, packet('entry_valid', 2, { 'x-render': 'valid' }, false));
    const before = observed(generations, 'entry_valid', 2);
    rememberGeneration(generations, key, null);
    rememberGeneration(generations, key, 'not a record');
    rememberGeneration(generations, key, new ArrayBuffer(1));

    expect(observed(generations, 'entry_valid', 2)).toBe(before);
    expect(generations.size).toBe(1);
  });
});
