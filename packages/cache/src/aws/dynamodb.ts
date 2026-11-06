import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { CacheHostError } from '@stayingupwind/runtime/cache-host';

import { type AuthorityStore, type Stored, stored, type StorePage } from './types.ts';

const BATCH_SIZE = 100;
const MAX_RETRIES = 8;

function sleep(attempt: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.min(1000, 10 * 2 ** attempt));
  });
}

/** Base-table reads only: GSI propagation must never hide an acknowledged invalidation. */
export class DynamoAuthorityStore implements AuthorityStore {
  readonly kind = 'dynamodb';
  readonly #client: DynamoDBDocumentClient;
  readonly #table: string;
  readonly #scope: string;

  constructor(region: string, table: string, scope: string, endpoint?: string) {
    this.#client = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region,
        maxAttempts: 3,
        requestHandler: {
          connectionTimeout: 1000,
          requestTimeout: 1000,
          throwOnRequestTimeout: true,
        },
        ...(endpoint === undefined
          ? {}
          : { endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }),
      }),
      {
        marshallOptions: { removeUndefinedValues: true },
      },
    );
    this.#table = table;
    this.#scope = scope;
  }

  now(): Promise<number> {
    return Promise.resolve(Date.now());
  }

  async read<T>(key: string, signal?: AbortSignal): Promise<Stored<T> | undefined> {
    const answer = await this.#client.send(
      new GetCommand({
        TableName: this.#table,
        Key: { pk: this.#scope, sk: key },
        ConsistentRead: true,
      }),
      signal === undefined ? {} : { abortSignal: signal },
    );
    const raw: unknown = answer.Item?.['value'];
    const expires: unknown = answer.Item?.['expiresAt'];
    if (typeof expires === 'number' && expires * 1000 <= Date.now()) return undefined;
    return typeof raw === 'string' ? stored<T>(raw) : undefined;
  }

  async readMany(
    keys: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, Stored>> {
    const unique = [...new Set(keys)];
    const result = new Map<string, Stored>();
    // Batches may be independent; four at a time avoids a render opening unbounded requests.
    for (let offset = 0; offset < unique.length; offset += BATCH_SIZE * 4) {
      await Promise.all(
        Array.from({ length: 4 }, async (_, index) => {
          const slice = unique.slice(
            offset + index * BATCH_SIZE,
            offset + (index + 1) * BATCH_SIZE,
          );
          let pending = slice.map((sk) => ({ pk: this.#scope, sk }));
          for (let attempt = 0; pending.length > 0; attempt += 1) {
            signal?.throwIfAborted();
            if (attempt >= MAX_RETRIES)
              throw new CacheHostError('DynamoDB left cache keys unread', {
                code: 'unavailable',
                status: 503,
              });
            if (attempt > 0) await sleep(attempt);
            const answer = await this.#client.send(
              new BatchGetCommand({
                RequestItems: {
                  [this.#table]: { Keys: pending, ConsistentRead: true },
                },
              }),
              signal === undefined ? {} : { abortSignal: signal },
            );
            for (const item of answer.Responses?.[this.#table] ?? []) {
              if (typeof item['expiresAt'] === 'number' && item['expiresAt'] * 1000 <= Date.now())
                continue;
              if (typeof item['sk'] === 'string' && typeof item['value'] === 'string')
                result.set(item['sk'], stored(item['value']));
            }
            pending = (answer.UnprocessedKeys?.[this.#table]?.Keys ?? []) as typeof pending;
          }
        }),
      );
    }
    return result;
  }

  async list(prefix: string, after?: string, limit = 100): Promise<StorePage> {
    const answer = await this.#client.send(
      new QueryCommand({
        TableName: this.#table,
        KeyConditionExpression:
          prefix === '' ? '#pk = :scope' : '#pk = :scope AND #sk BETWEEN :first AND :last',
        ExpressionAttributeNames: prefix === '' ? { '#pk': 'pk' } : { '#pk': 'pk', '#sk': 'sk' },
        ExpressionAttributeValues: {
          ':scope': this.#scope,
          ...(prefix === '' ? {} : { ':first': prefix, ':last': `${prefix}\uffff` }),
        },
        ConsistentRead: true,
        Limit: limit,
        ...(after === undefined ? {} : { ExclusiveStartKey: { pk: this.#scope, sk: after } }),
      }),
    );
    const items = (answer.Items ?? []).flatMap((item) => {
      if (typeof item['expiresAt'] === 'number' && item['expiresAt'] * 1000 <= Date.now())
        return [];
      return typeof item['sk'] === 'string' && typeof item['value'] === 'string'
        ? [{ key: item['sk'], stored: stored(item['value']) }]
        : [];
    });
    const cursor: unknown = answer.LastEvaluatedKey?.['sk'];
    return { items, ...(typeof cursor === 'string' ? { cursor } : {}) };
  }

  async change(
    expected: ReadonlyMap<string, string | null>,
    writes: ReadonlyMap<string, unknown | null>,
    notAfter?: number,
    expires: ReadonlyMap<string, number> = new Map(),
  ): Promise<boolean> {
    if (notAfter !== undefined && notAfter <= Date.now()) return false;
    const keys = [...new Set([...expected.keys(), ...writes.keys()])];
    if (keys.length > BATCH_SIZE) throw new Error('AWS cache transaction exceeds 100 items');
    const items: TransactWriteCommandInput['TransactItems'] = keys.map((key) => {
      const prior = expected.get(key);
      const condition: {
        ConditionExpression: string;
        ExpressionAttributeNames: Record<string, string>;
        ExpressionAttributeValues: Record<string, string | number>;
      } =
        prior === null
          ? {
              ConditionExpression: 'attribute_not_exists(#value) OR #expires <= :now',
              ExpressionAttributeNames: { '#value': 'value', '#expires': 'expiresAt' },
              ExpressionAttributeValues: { ':now': Math.floor(Date.now() / 1000) },
            }
          : {
              ConditionExpression: '#value = :prior',
              ExpressionAttributeNames: { '#value': 'value' },
              ExpressionAttributeValues: { ':prior': prior ?? '' },
            };
      const common = { TableName: this.#table, ...(prior === undefined ? {} : condition) };
      if (!writes.has(key)) {
        if (prior === undefined) throw new Error('AWS cache condition has no expected value');
        return {
          ConditionCheck: {
            TableName: this.#table,
            ...condition,
            Key: { pk: this.#scope, sk: key },
          },
        };
      }
      const value = writes.get(key);
      if (value === null) return { Delete: { ...common, Key: { pk: this.#scope, sk: key } } };
      const encoded = JSON.stringify(value);
      if (Buffer.byteLength(encoded) > 350_000)
        throw new CacheHostError('AWS cache metadata exceeds the DynamoDB item limit', {
          code: 'quota_exceeded',
          status: 413,
        });
      const expiry = expires.get(key);
      return {
        Put: {
          ...common,
          Item: {
            pk: this.#scope,
            sk: key,
            value: encoded,
            ...(expiry === undefined ? {} : { expiresAt: Math.floor(expiry / 1000) }),
          },
        },
      };
    });
    try {
      await this.#client.send(new TransactWriteCommand({ TransactItems: items }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'TransactionCanceledException') {
        const reasons = Reflect.get(error, 'CancellationReasons') as
          | { Code?: string }[]
          | undefined;
        if (
          reasons?.some(
            (reason) =>
              reason.Code === 'ConditionalCheckFailed' || reason.Code === 'TransactionConflict',
          )
        )
          return false;
      }
      throw error;
    }
  }

  close(): Promise<void> {
    this.#client.destroy();
    return Promise.resolve();
  }

  sweepExpired(): Promise<void> {
    return Promise.resolve();
  }
}
