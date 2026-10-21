import { listPages, unlessMissing } from './client.ts';
import type { AccountScope } from './workers.ts';

/**
 * The stores a deploy makes and finds on an account: KV namespaces, R2 buckets and their objects,
 * and D1 databases.
 *
 * Each is found by name — a KV namespace by its title, a bucket and a database by their names —
 * because nothing else is kept between runs (`names.ts`). A KV namespace's title is not unique on
 * an account, so finding one is finding every namespace of that title, and more than one is a
 * question a deploy refuses to guess the answer to.
 */

function account(scope: AccountScope): string {
  return `/accounts/${encodeURIComponent(scope.accountId)}`;
}

/** KV lists a page of at most this many. */
const KV_PAGE = 100;

export interface KvNamespace {
  readonly id: string;
  readonly title: string;
}

export async function listKvNamespaces(scope: AccountScope): Promise<readonly KvNamespace[]> {
  return listPages<KvNamespace>(scope.client, `${account(scope)}/storage/kv/namespaces`, {
    perPage: KV_PAGE,
  });
}

export async function createKvNamespace(scope: AccountScope, title: string): Promise<KvNamespace> {
  const answer = await scope.client.request<KvNamespace>(
    'POST',
    `${account(scope)}/storage/kv/namespaces`,
    { body: { title } },
  );
  return answer.result;
}

export async function deleteKvNamespace(scope: AccountScope, id: string): Promise<void> {
  await unlessMissing(
    scope.client.request(
      'DELETE',
      `${account(scope)}/storage/kv/namespaces/${encodeURIComponent(id)}`,
      { repeatable: true },
    ),
  );
}

export interface R2Bucket {
  readonly name: string;
  readonly creation_date?: string;
}

/** The bucket of that name, or nothing where the account has none. */
export async function getBucket(scope: AccountScope, name: string): Promise<R2Bucket | undefined> {
  const answer = await unlessMissing(
    scope.client.request<R2Bucket>(
      'GET',
      `${account(scope)}/r2/buckets/${encodeURIComponent(name)}`,
    ),
  );
  return answer?.result;
}

export async function createBucket(scope: AccountScope, name: string): Promise<R2Bucket> {
  const answer = await scope.client.request<R2Bucket>('POST', `${account(scope)}/r2/buckets`, {
    body: { name },
  });
  return answer.result;
}

/** Delete a bucket; Cloudflare refuses one that still holds objects. */
export async function deleteBucket(scope: AccountScope, name: string): Promise<void> {
  await unlessMissing(
    scope.client.request('DELETE', `${account(scope)}/r2/buckets/${encodeURIComponent(name)}`, {
      repeatable: true,
    }),
  );
}

function objectPath(scope: AccountScope, bucket: string, key: string): string {
  // The key keeps its slashes: R2 reads the rest of the path as the key.
  const encoded = key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `${account(scope)}/r2/buckets/${encodeURIComponent(bucket)}/objects/${encoded}`;
}

/** An object's bytes, or nothing where the bucket does not hold it. */
export async function getObject(
  scope: AccountScope,
  bucket: string,
  key: string,
): Promise<Uint8Array | undefined> {
  const response = await scope.client.raw('GET', objectPath(scope, bucket, key));
  return response === undefined ? undefined : new Uint8Array(await response.arrayBuffer());
}

/** Write an object, whole. */
export async function putObject(
  scope: AccountScope,
  bucket: string,
  object: { readonly key: string; readonly body: Uint8Array; readonly contentType: string },
): Promise<void> {
  const response = await scope.client.raw('PUT', objectPath(scope, bucket, object.key), {
    body: object.body,
    headers: { 'content-type': object.contentType },
    repeatable: true,
  });
  await response?.body?.cancel();
}

export interface D1Database {
  readonly uuid: string;
  readonly name: string;
}

/** D1 lists a page of at most this many. */
const D1_PAGE = 100;

/** The databases of that name: none, or one, since a name is unique on an account. */
export async function findD1Database(
  scope: AccountScope,
  name: string,
): Promise<D1Database | undefined> {
  const found = await listPages<D1Database>(scope.client, `${account(scope)}/d1/database`, {
    perPage: D1_PAGE,
    query: { name },
  });
  return found.find((database) => database.name === name);
}

export async function createD1Database(scope: AccountScope, name: string): Promise<D1Database> {
  const answer = await scope.client.request<D1Database>('POST', `${account(scope)}/d1/database`, {
    body: { name },
  });
  return answer.result;
}

export async function deleteD1Database(scope: AccountScope, uuid: string): Promise<void> {
  await unlessMissing(
    scope.client.request('DELETE', `${account(scope)}/d1/database/${encodeURIComponent(uuid)}`, {
      repeatable: true,
    }),
  );
}
