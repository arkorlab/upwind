import { createHash, randomUUID } from 'node:crypto';

import {
  CacheHostError,
  type TagDelta,
  type TagInvalidations,
} from '@stayingupwind/runtime/cache-host';

import type { InvalidationEvent, ProjectorLease, ScopeState, TagState } from './model.ts';
import { mergedTag } from './semantics.ts';
import {
  type AuthorityStore,
  MAX_CHANGE_TRIES,
  MAX_PENDING_EVENTS,
  PAGE_TAGS,
  PROJECTOR_KEY,
  PROJECTOR_LEASE_MS,
  revisionKey,
  SCOPE_KEY,
  type Stored,
} from './types.ts';

export function tagKey(value: string): string {
  return `tag:${createHash('sha256').update(value).digest('hex')}`;
}

export function tagRevisionKey(tag: TagState): string {
  return `${revisionKey('tag-revision:', tag.revision)}:${tagKey(tag.value)}`;
}

export function busy(): never {
  throw new CacheHostError('AWS cache metadata changed too often to obtain a consistent view', {
    code: 'unavailable',
    status: 503,
  });
}

export async function scopeOf(store: AuthorityStore): Promise<Stored<ScopeState>> {
  const scope = await store.read<ScopeState>(SCOPE_KEY);
  if (scope === undefined || scope.value.format !== 1 || scope.value.status === 'retired')
    throw new CacheHostError('AWS cache scope is unavailable', {
      code: 'scope_retired',
      status: 503,
    });
  return scope;
}

export interface TagSnapshot {
  readonly scope: Stored<ScopeState>;
  readonly tags: ReadonlyMap<string, TagState>;
}

/** Bounded committed tail; individual projections may already contain some of these marks. */
async function eventsAfter(store: AuthorityStore, scope: ScopeState): Promise<InvalidationEvent[]> {
  const events: InvalidationEvent[] = [];
  let cursor: string | undefined = revisionKey('event:', scope.checkpoint);
  do {
    const page = await store.list('event:', cursor, MAX_PENDING_EVENTS + 1);
    for (const item of page.items) {
      const event = item.stored.value as InvalidationEvent;
      if (event.revision <= scope.revision) events.push(event);
    }
    if (events.length > MAX_PENDING_EVENTS)
      throw new Error('AWS cache invalidation tail exceeds its bound');
    cursor = page.cursor;
  } while (cursor !== undefined);
  return events;
}

export class AwsTags {
  readonly #store: AuthorityStore;
  readonly #owner = randomUUID();
  #projecting: Promise<boolean> | undefined;

  constructor(store: AuthorityStore) {
    this.#store = store;
  }

  async snapshot(values: readonly string[]): Promise<TagSnapshot> {
    const wanted = [...new Set(values)];
    for (let attempt = 0; attempt < MAX_CHANGE_TRIES; attempt += 1) {
      const scope = await scopeOf(this.#store);
      const [rows, events] = await Promise.all([
        this.#store.readMany(wanted.map(tagKey)),
        eventsAfter(this.#store, scope.value),
      ]);
      const tags = new Map<string, TagState>();
      for (const value of wanted) {
        const row = rows.get(tagKey(value));
        if (row !== undefined) tags.set(value, row.value as TagState);
      }
      const selected = new Set(wanted);
      for (const event of events)
        for (const value of event.values)
          if (selected.has(value)) tags.set(value, mergedTag(tags.get(value), event, value));
      const after = await scopeOf(this.#store);
      if (
        after.value.invalidationRevision === scope.value.invalidationRevision &&
        after.value.checkpoint === scope.value.checkpoint
      )
        return { scope: after, tags };
    }
    return busy();
  }

  async getTags(values: readonly string[]): Promise<TagInvalidations> {
    return { tags: [...(await this.snapshot(values)).tags.values()] };
  }

  /** Latest tags are indexed in the base table; no GSI and no lifetime-long log replay. */
  async delta(since: number): Promise<TagDelta> {
    for (let attempt = 0; attempt < MAX_CHANGE_TRIES; attempt += 1) {
      const scope = await scopeOf(this.#store);
      const tags = new Map<string, TagState>();
      let cursor: string | undefined = `${revisionKey('tag-revision:', since)}\uffff`;
      let more = false;
      do {
        const page = await this.#store.list('tag-revision:', cursor, PAGE_TAGS + 128);
        for (const item of page.items) {
          const tag = item.stored.value as TagState;
          const old = tags.get(tag.value);
          if (
            tag.revision <= scope.value.revision &&
            (old === undefined || old.revision < tag.revision)
          )
            tags.set(tag.value, tag);
        }
        cursor = page.cursor;
        more = cursor !== undefined;
      } while (cursor !== undefined && tags.size < PAGE_TAGS + 128);
      for (const event of await eventsAfter(this.#store, scope.value)) {
        if (event.revision <= since) continue;
        for (const value of event.values) tags.set(value, mergedTag(tags.get(value), event, value));
      }
      const after = await scopeOf(this.#store);
      if (
        after.value.invalidationRevision !== scope.value.invalidationRevision ||
        after.value.checkpoint !== scope.value.checkpoint
      )
        continue;
      const ordered = [...tags.values()]
        .filter((tag) => tag.revision > since)
        .sort((a, b) => a.revision - b.revision || a.value.localeCompare(b.value));
      if (!more && ordered.length <= PAGE_TAGS)
        return { tags: ordered, revision: scope.value.revision, truncated: false };
      const boundary = ordered[Math.min(PAGE_TAGS, ordered.length) - 1]?.revision;
      if (boundary === undefined)
        return { tags: [], revision: scope.value.revision, truncated: false };
      let selected = ordered.filter((tag) => tag.revision < boundary);
      if (selected.length === 0) selected = ordered.filter((tag) => tag.revision === boundary);
      return { tags: selected, revision: selected.at(-1)?.revision ?? boundary, truncated: true };
    }
    return busy();
  }

  project(): Promise<boolean> {
    if (this.#projecting !== undefined) return this.#projecting;
    const running = this.#project();
    this.#projecting = running;
    void running
      .finally(() => {
        if (this.#projecting === running) this.#projecting = undefined;
      })
      .catch(() => undefined);
    return running;
  }

  async #project(): Promise<boolean> {
    const initial = await scopeOf(this.#store);
    if (initial.value.pending === 0) return false;
    const before = await this.#store.read<ProjectorLease>(PROJECTOR_KEY);
    if (before !== undefined && before.value.expiresAt > Date.now()) return false;
    const lease: ProjectorLease = {
      owner: this.#owner,
      fence: (before?.value.fence ?? 0) + 1,
      expiresAt: Date.now() + PROJECTOR_LEASE_MS,
    };
    if (
      !(await this.#store.change(
        new Map([[PROJECTOR_KEY, before?.raw ?? null]]),
        new Map([[PROJECTOR_KEY, lease]]),
      ))
    )
      return false;
    let leaseRaw = JSON.stringify(lease);
    const page = await this.#store.list(
      'event:',
      revisionKey('event:', initial.value.checkpoint),
      1,
    );
    const first = page.items[0];
    if (first === undefined) throw new Error('AWS cache checkpoint has no pending event');
    const event = first.stored.value as InvalidationEvent;
    for (let offset = 0; offset < event.values.length; offset += 32) {
      const values = event.values.slice(offset, offset + 32);
      for (let tries = 0; ; tries += 1) {
        if (tries >= MAX_CHANGE_TRIES) return busy();
        const held = await this.#store.read<ProjectorLease>(PROJECTOR_KEY);
        if (held?.raw !== leaseRaw || held.value.expiresAt <= Date.now()) return false;
        const renewed = { ...held.value, expiresAt: Date.now() + PROJECTOR_LEASE_MS };
        if (
          !(await this.#store.change(
            new Map([[PROJECTOR_KEY, leaseRaw]]),
            new Map([[PROJECTOR_KEY, renewed]]),
          ))
        )
          return false;
        leaseRaw = JSON.stringify(renewed);
        const prior = await this.#store.readMany(values.map(tagKey));
        const expected = new Map<string, string | null>([[PROJECTOR_KEY, leaseRaw]]);
        const writes = new Map<string, unknown | null>();
        for (const value of values) {
          const key = tagKey(value);
          const old = prior.get(key);
          const oldTag = old?.value as TagState | undefined;
          if (oldTag !== undefined && oldTag.revision >= event.revision) continue;
          const tag = mergedTag(oldTag, event, value);
          expected.set(key, old?.raw ?? null);
          writes.set(key, tag);
          if (oldTag !== undefined) writes.set(tagRevisionKey(oldTag), null);
          writes.set(tagRevisionKey(tag), tag);
        }
        if (writes.size === 0 || (await this.#store.change(expected, writes))) break;
      }
    }
    for (let attempt = 0; attempt < MAX_CHANGE_TRIES; attempt += 1) {
      const scope = await scopeOf(this.#store);
      if (scope.value.checkpoint >= event.revision) return true;
      if (scope.value.checkpoint !== initial.value.checkpoint) return false;
      const held = await this.#store.read<ProjectorLease>(PROJECTOR_KEY);
      if (held?.raw !== leaseRaw || held.value.expiresAt <= Date.now()) return false;
      if (
        await this.#store.change(
          new Map([
            [SCOPE_KEY, scope.raw],
            [PROJECTOR_KEY, leaseRaw],
            [first.key, first.stored.raw],
          ]),
          new Map<string, unknown | null>([
            [
              SCOPE_KEY,
              { ...scope.value, checkpoint: event.revision, pending: scope.value.pending - 1 },
            ],
            [PROJECTOR_KEY, { ...held.value, expiresAt: 0 }],
            [first.key, null],
          ]),
        )
      )
        return true;
    }
    return busy();
  }
}
