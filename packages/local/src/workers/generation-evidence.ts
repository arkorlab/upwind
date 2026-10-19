import {
  decodeGenerationPack,
  type DecodedGenerationPack,
  kvGenerationKey,
  type PackArtifactRef,
} from '@stayingupwind/core/cache';
import { allowRecoveryScript } from '@stayingupwind/core/request';
import { RECOVERY_SCRIPT_CSP_SOURCE } from '@stayingupwind/host/splice';

import type { RecordedGeneration, RecordedOutput } from './protocol.ts';

/** An output's public identity and bytes, without its storage location. */
function outputOf(artifact: PackArtifactRef): RecordedOutput {
  const { role, representationKey, encoding, sha256, byteLength } = artifact;
  return { role, representationKey, encoding, sha256, byteLength };
}

/** Metadata alone, with the same recovery permission as the generation loader. */
function generationMetadata(pack: DecodedGenerationPack): RecordedGeneration {
  const { headers, artifacts, postponedSha256, source } = pack.header;
  const { policy, cacheTimestamp, invalidation } = pack.header;
  const permitted =
    headers['content-security-policy'] === undefined || pack.postponed === undefined
      ? headers
      : allowRecoveryScript(headers, RECOVERY_SCRIPT_CSP_SOURCE);
  return {
    headers: permitted,
    artifacts: artifacts.map((artifact) => outputOf(artifact)),
    partial: postponedSha256 !== null,
    source,
    freshness: { policy, cacheTimestamp, invalidation },
  };
}

/** Only the cache's pack is inspected; no Worker environment type enters the metadata helper. */
interface HeldPack {
  readonly pack: DecodedGenerationPack;
}

interface GenerationMemory<V extends HeldPack> {
  get(key: string): V | undefined;
  set(key: string, value: V, bytes: number): unknown;
}

/** Observe actual memory hits and adoptions, preserving the cache's private receiver and values. */
export function watchedGenerationMemory<V extends HeldPack, M extends GenerationMemory<V>>(
  memory: M,
  observed: (key: string, pack: DecodedGenerationPack) => void,
): M {
  return new Proxy(memory, {
    get(target, property): unknown {
      if (property === 'get') {
        return (key: string): V | undefined => {
          const held = target.get(key);
          if (held !== undefined) observed(key, held.pack);
          return held;
        };
      }
      if (property === 'set') {
        return (key: string, held: V, bytes: number): unknown => {
          observed(key, held.pack);
          return target.set(key, held, bytes);
        };
      }
      const member: unknown = Reflect.get(target, property, target);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
}

/** Active validation requests own snapshots; ordinary serve requests own no evidence map. */
export class GenerationEvidence {
  readonly #traces = new Map<string, Map<string, RecordedGeneration>>();
  readonly #active = new Set<string>();
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  begin(trace: string): void {
    this.#traces.delete(trace);
    this.#traces.set(trace, new Map());
    this.#active.add(trace);
    if (this.#traces.size > this.#limit) {
      const [oldest] = this.#traces.keys();
      if (oldest !== undefined) this.forget(oldest);
    }
  }

  forget(trace: string): void {
    this.#active.delete(trace);
    this.#traces.delete(trace);
  }

  /** Retain a completed response's snapshot, without absorbing later server traffic. */
  seal(trace: string): void {
    this.#active.delete(trace);
  }

  /** A coalesced read can belong to several requests; keep one metadata object for active checks. */
  observeActive(key: string, value: unknown): void {
    if (this.#active.size === 0 || !(value instanceof ArrayBuffer)) return;
    const decoded = decodeGenerationPack(new Uint8Array(value));
    if (decoded.kind === 'ok') this.heldActive(key, decoded.pack);
  }

  heldActive(key: string, pack: DecodedGenerationPack): void {
    if (this.#active.size === 0) return;
    const metadata = generationMetadata(pack);
    const at = `${key}|${pack.header.seq}`;
    for (const trace of this.#active) this.#traces.get(trace)?.set(at, metadata);
  }

  snapshot(trace: string): Readonly<Record<string, RecordedGeneration>> {
    return Object.fromEntries(this.#traces.get(trace) ?? []);
  }

  /** The actual byte-budgeted cache remains the evidence for untraced prewarming and memory hits. */
  forRecord(held: Iterable<HeldPack>, key: string): Readonly<Record<string, RecordedGeneration>> {
    const found = new Map<string, RecordedGeneration>();
    for (const { pack } of held) {
      if (kvGenerationKey(pack.header.scopeId, pack.header.entryId) === key) {
        found.set(String(pack.header.seq), generationMetadata(pack));
      }
    }
    const prefix = `${key}|`;
    for (const generations of this.#traces.values()) {
      for (const [at, generation] of generations) {
        if (at.startsWith(prefix)) found.set(at.slice(prefix.length), generation);
      }
    }
    return Object.fromEntries(found);
  }
}
