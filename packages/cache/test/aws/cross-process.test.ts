import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import type { WorkerActions, WorkerResponse, WorkerSettings } from './cross-process-worker.ts';

/** Plain Node children deliberately bypass Vitest's module graph and all parent-process memory. */
class AuthorityProcess {
  readonly #child = fork(new URL('./cross-process-worker.ts', import.meta.url), [], {
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  readonly #exited: Promise<void>;
  #nextId = 0;
  #diagnostics = '';

  constructor() {
    const capture = (chunk: Buffer) => {
      this.#diagnostics = (this.#diagnostics + chunk.toString()).slice(-8000);
    };
    this.#child.stdout?.on('data', capture);
    this.#child.stderr?.on('data', capture);
    this.#child.on('message', (response: WorkerResponse) => {
      const pending = this.#pending.get(response.id);
      if (pending === undefined) return;
      this.#pending.delete(response.id);
      if (response.ok) pending.resolve(response.value);
      else pending.reject(new Error(response.error));
    });
    this.#child.on('error', (error) => this.#rejectPending(error));
    this.#exited = new Promise((resolve) => {
      this.#child.once('exit', (code, signal) => {
        this.#rejectPending(
          new Error(`Cache child exited (${code ?? signal}): ${this.#diagnostics}`),
        );
        resolve();
      });
    });
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  call<Action extends keyof WorkerActions>(
    action: Action,
    input: WorkerActions[Action]['input'],
  ): Promise<WorkerActions[Action]['output']> {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Cache child timed out during ${action}: ${this.#diagnostics}`));
      }, 15_000);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as WorkerActions[Action]['output']);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.#child.send({ id, action, input }, (error) => {
          if (error !== null) this.#rejectPending(error);
        });
      } catch (error) {
        this.#rejectPending(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    try {
      if (this.#child.connected) await this.call('close', undefined);
    } finally {
      this.#child.kill();
      await this.#exited;
    }
  }
}

function crossProcessContract(settings: (scope: string) => WorkerSettings): void {
  test('independent processes observe invalidations immediately and elect exactly one renderer', async () => {
    const config = settings(`process_${randomUUID()}`);
    const writer = new AuthorityProcess();
    const reader = new AuthorityProcess();
    try {
      const [first, second] = await Promise.all([
        writer.call('initialize', config),
        reader.call('initialize', config),
      ]);
      expect(first.pid).not.toBe(second.pid);
      expect(first.pid).not.toBe(process.pid);
      expect(second.pid).not.toBe(process.pid);

      // Warm a missing tag, then an existing tag, before separate acknowledged invalidations.
      expect(await reader.call('snapshot', { tags: ['product'] })).toEqual({
        revision: { revision: 0, invalidatedAt: null },
        tags: { tags: [] },
      });
      let previous = 0;
      for (let round = 0; round < 2; round += 1) {
        const invalidated = await writer.call('invalidate', { tags: ['product'] });
        expect(invalidated.revision).toBeGreaterThan(previous);
        const snapshot = await reader.call('snapshot', { tags: ['product'] });
        expect(snapshot.revision.revision).toBe(invalidated.revision);
        expect(snapshot.revision.invalidatedAt).toEqual(expect.any(Number));
        expect(snapshot.tags.tags).toHaveLength(1);
        expect(snapshot.tags.tags[0]).toMatchObject({
          value: 'product',
          revision: invalidated.revision,
          hardExpireAt: expect.any(Number),
        });
        previous = invalidated.revision ?? 0;
      }

      // Both children start at the same wall-clock barrier, with separate remote connections.
      const lease = { pathname: '/cross-process-lease', startAt: Date.now() + 250 };
      const outcomes = await Promise.all([
        writer.call('lease', lease),
        reader.call('lease', lease),
      ]);
      expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['busy', 'leased']);
      const owner = outcomes.find((outcome) => outcome.kind === 'leased');
      const contender = outcomes.find((outcome) => outcome.kind === 'busy');
      expect(owner).toBeDefined();
      expect(contender?.attemptId).toBe(owner?.attemptId);
    } finally {
      // Stop the reader's background projector before retiring the shared test scope.
      try {
        await reader.close();
      } finally {
        try {
          await writer.call('retire', undefined);
        } finally {
          await writer.close();
        }
      }
    }
  }, 60_000);
}

const valkeyUrl = process.env['UPWIND_TEST_VALKEY_URL'];
describe.skipIf(valkeyUrl === undefined)('Valkey across Node processes', () => {
  crossProcessContract((scope) => ({ backend: 'valkey', scope, url: valkeyUrl ?? '' }));
});

const endpoint = process.env['UPWIND_TEST_DYNAMODB_ENDPOINT'];
describe.skipIf(endpoint === undefined)('DynamoDB across Node processes', () => {
  const table = `upwind-processes-${randomUUID()}`;
  const client = new DynamoDBClient({
    region: 'us-east-1',
    endpoint,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  beforeAll(async () => {
    await client.send(
      new CreateTableCommand({
        TableName: table,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
      }),
    );
    await waitUntilTableExists({ client, maxWaitTime: 20 }, { TableName: table });
  });
  afterAll(async () => {
    try {
      await client.send(new DeleteTableCommand({ TableName: table }));
    } finally {
      client.destroy();
    }
  });
  crossProcessContract((scope) => ({
    backend: 'dynamodb',
    scope,
    endpoint: endpoint ?? '',
    table,
  }));
});
