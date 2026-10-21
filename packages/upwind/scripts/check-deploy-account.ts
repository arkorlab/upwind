import {
  deleteBucket,
  deleteKvNamespace,
  listKvNamespaces,
} from '../src/deploy/cloudflare/storage.ts';
import { type AccountScope, listScripts } from '../src/deploy/cloudflare/workers.ts';

/**
 * What `check-deploy.ts` reads of the account: everything named for a `ci-<run>-<attempt>` project,
 * to see one gone after its destroy and to find the ones earlier runs left behind.
 */

/** A `ci-*` project older than this, six hours, was left behind by a run that is over. */
const STALE_AFTER_MS = 21_600_000;
/** The names the run gives a project: `ci-<run>-<attempt>`. */
export const CI_PROJECT = /^ci-\d{1,12}-\d{1,3}$/u;
const CI_WORKER =
  /^(ci-\d{1,12}-\d{1,3})-(?:edge|cache|cache-read|prefetch|agent|[2-7a-z]{25}-(?:app(?:-\d{1,3})?|mw))$/u;
const CI_BUCKET = /^(ci-\d{1,12}-\d{1,3})-artifacts$/u;
const CI_NAMESPACE = /^upwind:(ci-\d{1,12}-\d{1,3}):/u;
/** A page of buckets, as many as R2 lists at once. */
const BUCKET_PAGE = 1000;

export interface Leftovers {
  readonly workers: readonly { readonly id: string; readonly created_on?: string | undefined }[];
  readonly namespaces: readonly { readonly id: string; readonly title: string }[];
  readonly buckets: readonly {
    readonly name: string;
    readonly creation_date?: string | undefined;
  }[];
}

async function listBuckets(scope: AccountScope): Promise<Leftovers['buckets']> {
  const found: { name: string; creation_date?: string }[] = [];
  let cursor: string | undefined;
  do {
    const answer = await scope.client.request<{
      readonly buckets?: readonly { name: string; creation_date?: string }[];
    }>('GET', `/accounts/${encodeURIComponent(scope.accountId)}/r2/buckets`, {
      query: { per_page: BUCKET_PAGE, cursor },
    });
    found.push(...(answer.result.buckets ?? []));
    cursor = answer.resultInfo?.cursor === '' ? undefined : answer.resultInfo?.cursor;
  } while (cursor !== undefined);
  return found;
}

export async function everything(scope: AccountScope): Promise<Leftovers> {
  const [workers, namespaces, buckets] = await Promise.all([
    listScripts(scope),
    listKvNamespaces(scope),
    listBuckets(scope),
  ]);
  return { workers, namespaces, buckets };
}

/** What the account holds named for the project. */
export async function leftOf(scope: AccountScope, project: string): Promise<string[]> {
  const { workers, namespaces, buckets } = await everything(scope);
  return [
    ...workers.map((worker) => worker.id).filter((name) => CI_WORKER.exec(name)?.[1] === project),
    ...namespaces
      .map((namespace) => namespace.title)
      .filter((title) => CI_NAMESPACE.exec(title)?.[1] === project),
    ...buckets.map((bucket) => bucket.name).filter((name) => CI_BUCKET.exec(name)?.[1] === project),
  ];
}

/**
 * The `ci-*` projects earlier runs left, by the newest of what they hold. Runs of this workflow
 * never overlap (its `concurrency`), so every other project is one whose run is over; six hours is
 * margin for one somebody is looking at. A project of nothing but namespaces — a destroy stopped
 * after its owner mark went — has no date to go by, and is taken as over.
 */
export function staleProjects(all: Leftovers, current: string, now: number): Set<string> {
  const newest = new Map<string, number>();
  const seen = (project: string | undefined, date: string | undefined): void => {
    if (project === undefined || project === current) {
      return;
    }
    const at = date === undefined ? NaN : Date.parse(date);
    newest.set(project, Math.max(newest.get(project) ?? 0, Number.isNaN(at) ? 0 : at));
  };
  for (const worker of all.workers) {
    seen(CI_WORKER.exec(worker.id)?.[1], worker.created_on);
  }
  for (const bucket of all.buckets) {
    seen(CI_BUCKET.exec(bucket.name)?.[1], bucket.creation_date);
  }
  for (const namespace of all.namespaces) {
    seen(CI_NAMESPACE.exec(namespace.title)?.[1], undefined);
  }
  return new Set(
    [...newest].filter(([, at]) => now - at > STALE_AFTER_MS).map(([project]) => project),
  );
}

export async function sweep(scope: AccountScope, project: string): Promise<void> {
  const { namespaces, buckets } = await everything(scope);
  const named = namespaces.filter((one) => CI_NAMESPACE.exec(one.title)?.[1] === project);
  for (const namespace of named) {
    await deleteKvNamespace(scope, namespace.id);
  }
  const bucketsOf = buckets.filter((one) => CI_BUCKET.exec(one.name)?.[1] === project);
  for (const bucket of bucketsOf) {
    try {
      await deleteBucket(scope, bucket.name);
    } catch (error) {
      console.warn(
        `check-deploy: ${bucket.name} stays: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
