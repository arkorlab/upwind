import { NEXT_ONE_YEAR_SECONDS } from '@stayingupwind/core/cache';
import {
  DEFAULT_D1_CACHE_TAG,
  type FunctionEnv,
  RESOURCE_CHANGES_SERVICE_BINDING,
  type ResourceChangeAcknowledgement,
  type ResourceChangesReceiver,
  revalidateNextResource,
} from '@stayingupwind/core/paas';

import { nowMs } from './cache/clock.ts';
import { recordResourceReceipt, requestContext } from './cache/context.ts';

/** Bound mutation latency even if the service accepts a report but never returns its answer. */
export const RESOURCE_CHANGE_DELIVERY_TIMEOUT_MS = 750;
const MS_PER_SECOND = 1000;

async function withinDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Resource change delivery timed out'));
        }, RESOURCE_CHANGE_DELIVERY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function acknowledgement(value: unknown): value is ResourceChangeAcknowledgement {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate['v'] === 1 &&
    candidate['kind'] === 'accepted' &&
    Number.isSafeInteger(candidate['revision']) &&
    (candidate['revision'] as number) >= 0
  );
}

/** The write side alone contacts Control; reads and cache GETs never reach this service. */
export async function reportResourceChange(
  env: FunctionEnv | undefined,
  bindingName: string,
): Promise<void> {
  const service = env?.[RESOURCE_CHANGES_SERVICE_BINDING] as ResourceChangesReceiver | undefined;
  if (service === undefined) {
    // Other hosts and local development can still use Next's ordinary invalidation path.
    revalidateNextResource(DEFAULT_D1_CACHE_TAG);
    return;
  }
  const report = { eventId: crypto.randomUUID(), type: 'd1' as const, bindingName };
  const context = requestContext();
  const now = nowMs();
  context?.runtime?.tags.applyLocal([DEFAULT_D1_CACHE_TAG], {
    staleAt: now,
    hardExpireAt: now + NEXT_ONE_YEAR_SECONDS * MS_PER_SECOND,
  });
  let lastError: unknown;
  const deliver = async (): Promise<boolean> => {
    // A transport error may follow durable acceptance. Retry this event, never replay the SQL.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const answer = await withinDeadline(service.reportResourceChange(report));
        if (!acknowledgement(answer))
          throw new Error('Invalid Upwind resource-change acknowledgement');
        recordResourceReceipt(DEFAULT_D1_CACHE_TAG, answer.revision);
        return true;
      } catch (error) {
        lastError = error;
      }
    }
    return false;
  };
  const recordFailure = (): void => {
    const fields = {
      eventId: report.eventId,
      bindingName,
      detail: lastError instanceof Error ? lastError.message : String(lastError),
    };
    if (context?.runtime === undefined) {
      // eslint-disable-next-line no-console -- record the unacknowledged event without any binding credentials
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'upwind: resource change delivery failed',
          ...fields,
        }),
      );
    } else {
      context.runtime.log('resource change delivery failed', fields);
    }
  };
  const accepted = await deliver();
  const deliverBehind = async (): Promise<void> => {
    const delivered = await deliver();
    if (!delivered) recordFailure();
  };
  // Real Next pending tags retain redirect/same-request semantics. 'max' does not flush the
  // browser router cache; native handler fanout is coalesced against the receipt above.
  revalidateNextResource(DEFAULT_D1_CACHE_TAG);
  if (!accepted) {
    if (context === undefined) {
      recordFailure();
    } else {
      try {
        context.waitUntil(deliverBehind());
      } catch {
        recordFailure();
      }
    }
  }
}
