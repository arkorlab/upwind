import { randomUUID } from 'node:crypto';

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { DynamoAuthorityStore } from '../../src/aws/dynamodb.ts';
import { ValkeyAuthorityStore } from '../../src/aws/valkey.ts';
import { cacheContract } from './contract.ts';

const valkeyUrl = process.env['UPWIND_TEST_VALKEY_URL'];
describe.skipIf(valkeyUrl === undefined)('real Valkey transport', () => {
  cacheContract('Valkey atomic Lua', async (scope) => {
    const store = new ValkeyAuthorityStore(valkeyUrl ?? '', scope, undefined, undefined, true);
    await store.connect();
    return store;
  });
  test('the server rejects an expired publication deadline', async () => {
    const store = new ValkeyAuthorityStore(
      valkeyUrl ?? '',
      `clock_${randomUUID()}`,
      undefined,
      undefined,
      true,
    );
    await store.connect();
    try {
      const expired = (await store.now()) - 1;
      expect(
        await store.change(new Map([['key', null]]), new Map([['key', 'late']]), expired),
      ).toBe(false);
      expect(await store.read('key')).toBeUndefined();
    } finally {
      await store.close();
    }
  });
});

const endpoint = process.env['UPWIND_TEST_DYNAMODB_ENDPOINT'];
describe.skipIf(endpoint === undefined)('real DynamoDB transport', () => {
  const table = `upwind-cache-${randomUUID()}`;
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
  }, 30_000);
  afterAll(async () => {
    await client.send(new DeleteTableCommand({ TableName: table }));
    client.destroy();
  });
  cacheContract('DynamoDB conditional transactions', (scope) =>
    Promise.resolve(new DynamoAuthorityStore('us-east-1', table, scope, endpoint)),
  );
});
