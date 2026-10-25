/* eslint-disable security/detect-non-literal-fs-filename -- Paths use the configured private cache directory and hashed opaque keys only. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { createRepairStorageRef } from '@stayingupwind/core/cache';

import { BlobLengthError, type BlobStore, type KvSink } from '../scope/io.ts';

type ObjectKind = 'blob' | 'kv';
const LIST_PAGE_SIZE = 200;

/** Opaque logical keys are hashed into filenames; no request supplies a filesystem path. */
export class CacheFiles {
  readonly #directory: string;
  readonly #database: DatabaseSync;

  readonly kv: KvSink & { get: (key: string) => Promise<string | null> } = {
    get: async (key) => {
      const bytes = await this.read('kv', key);
      return bytes === undefined ? null : new TextDecoder().decode(bytes);
    },
    put: (key, bytes) => this.write('kv', key, bytes),
    delete: (key) => this.remove('kv', key),
    listPage: ({ prefix, cursor, limit }) => {
      const page = this.#list('kv', prefix, cursor, limit);
      return Promise.resolve({ keys: page.page.map((row) => row.key), cursor: page.cursor });
    },
  };

  readonly blobs: BlobStore = {
    read: async (key, length) => {
      try {
        const info = await stat(this.#file('blob', key));
        if (info.size !== length) throw new BlobLengthError(info.size, length);
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          return;
        }
        throw error;
      }
      return this.read('blob', key);
    },
    exists: async (key) => {
      try {
        await stat(this.#file('blob', key));
        return true;
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return false;
        throw error;
      }
    },
    write: (key, bytes) => this.write('blob', key, bytes),
    delete: async (keys) => {
      for (const key of keys) await this.remove('blob', key);
    },
    deletePrefix: async (prefix) => {
      for (;;) {
        const { page } = this.#list('blob', prefix, undefined, LIST_PAGE_SIZE);
        for (const row of page) await this.remove('blob', row.key);
        if (page.length < LIST_PAGE_SIZE) return;
      }
    },
    listPage: ({ prefix, cursor, limit }) => {
      const result = this.#list('blob', prefix, cursor, limit);
      return Promise.resolve({
        objects: result.page.map((row) => ({ key: row.key, uploadedAt: row.uploaded_at })),
        cursor: result.cursor,
      });
    },
    verifiedRepair: async (key, proof) => {
      const bytes = await this.read('blob', key);
      return (
        bytes?.byteLength === proof.byteLength &&
        createHash('sha256').update(bytes).digest('hex') === proof.sha256
      );
    },
    copyRepair: async (location, owner) => {
      const bytes = await this.read('blob', location.storageRef);
      if (
        bytes?.byteLength !== location.byteLength ||
        createHash('sha256').update(bytes).digest('hex') !== location.sha256
      )
        return;
      const key = createRepairStorageRef(owner.namespace);
      await this.write('blob', key, bytes);
      return key;
    },
  };

  constructor(directory: string, database: DatabaseSync) {
    this.#directory = path.join(directory, 'objects');
    this.#database = database;
    database.exec(`CREATE TABLE IF NOT EXISTS native_objects (
      kind TEXT NOT NULL, key TEXT NOT NULL, uploaded_at INTEGER NOT NULL,
      PRIMARY KEY (kind, key)
    )`);
  }

  #file(kind: ObjectKind, key: string): string {
    return path.join(this.#directory, createHash('sha256').update(`${kind}\0${key}`).digest('hex'));
  }

  #list(kind: ObjectKind, prefix: string, cursor: string | undefined, limit: number) {
    const rows = this.#database
      .prepare(`SELECT key,uploaded_at FROM native_objects
      WHERE kind=? AND substr(key,1,?)=? AND key>? ORDER BY key LIMIT ?`)
      .all(kind, prefix.length, prefix, cursor ?? '', limit + 1) as {
      key: string;
      uploaded_at: number;
    }[];
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    return { page, cursor: more ? page.at(-1)?.key : undefined };
  }

  async init(): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
  }

  async read(kind: ObjectKind, key: string): Promise<Uint8Array | undefined> {
    try {
      return await readFile(this.#file(kind, key));
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async write(kind: ObjectKind, key: string, bytes: string | Uint8Array): Promise<void> {
    const target = this.#file(kind, key);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      {
        await using handle = await open(temporary, 'wx');
        await handle.writeFile(bytes);
        await handle.sync();
      }
      await rename(temporary, target);
      this.#database
        .prepare(`INSERT INTO native_objects(kind,key,uploaded_at) VALUES(?,?,?)
        ON CONFLICT(kind,key) DO UPDATE SET uploaded_at=excluded.uploaded_at`)
        .run(kind, key, Date.now());
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async remove(kind: ObjectKind, key: string): Promise<void> {
    await rm(this.#file(kind, key), { force: true });
    this.#database.prepare('DELETE FROM native_objects WHERE kind=? AND key=?').run(kind, key);
  }
}
