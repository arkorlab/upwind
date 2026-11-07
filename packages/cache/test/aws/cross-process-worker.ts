import { setTimeout } from 'node:timers/promises';

import type { ScopeRevision } from '@stayingupwind/core/paas';
import type {
  AttemptOutcome,
  InvalidateOutcome,
  TagInvalidations,
} from '@stayingupwind/runtime/cache-host';

import { AwsAuthority } from '../../src/aws/authority.ts';
import { DynamoAuthorityStore } from '../../src/aws/dynamodb.ts';
import type { AuthorityStore } from '../../src/aws/types.ts';
import { ValkeyAuthorityStore } from '../../src/aws/valkey.ts';
import { MemoryObjects, options } from './support.ts';

export type WorkerSettings =
  | { backend: 'valkey'; scope: string; url: string }
  | { backend: 'dynamodb'; scope: string; endpoint: string; table: string };

export interface WorkerActions {
  initialize: { input: WorkerSettings; output: { pid: number } };
  snapshot: {
    input: { tags: readonly string[] };
    output: { revision: ScopeRevision; tags: TagInvalidations };
  };
  invalidate: { input: { tags: readonly string[] }; output: InvalidateOutcome };
  lease: { input: { pathname: string; startAt: number }; output: AttemptOutcome };
  retire: { input: undefined; output: undefined };
  close: { input: undefined; output: undefined };
}

export type WorkerRequest = {
  [Action in keyof WorkerActions]: {
    id: number;
    action: Action;
    input: WorkerActions[Action]['input'];
  };
}[keyof WorkerActions];

export type WorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };

let authority: AwsAuthority | undefined;

async function execute(request: WorkerRequest): Promise<unknown> {
  if (request.action === 'initialize') {
    const settings = request.input;
    let store: AuthorityStore;
    if (settings.backend === 'valkey') {
      const valkey = new ValkeyAuthorityStore(
        settings.url,
        settings.scope,
        undefined,
        undefined,
        true,
      );
      await valkey.connect();
      store = valkey;
    } else {
      store = new DynamoAuthorityStore(
        'us-east-1',
        settings.table,
        settings.scope,
        settings.endpoint,
      );
    }
    // Each OS process owns its connections, host state and objects; only the remote authority is shared.
    authority = new AwsAuthority(
      options(settings.backend, settings.scope),
      store,
      new MemoryObjects(),
    );
    await authority.initialize();
    return { pid: process.pid };
  }
  if (request.action === 'close') {
    await authority?.close();
    authority = undefined;
    return undefined;
  }
  if (authority === undefined) throw new Error('The child authority has not been initialized');
  switch (request.action) {
    case 'snapshot':
      return {
        revision: await authority.readScopeRevision(),
        tags: await authority.getTags(request.input.tags),
      };
    case 'invalidate':
      return authority.invalidate({ tags: request.input.tags, api: 'updateTag' });
    case 'lease':
      await setTimeout(Math.max(0, request.input.startAt - Date.now()));
      return authority.startAttempt({
        entry: {
          kind: 'app-page',
          route: request.input.pathname,
          pathname: request.input.pathname,
        },
        reason: 'miss',
      });
    case 'retire':
      await authority.retire();
      return undefined;
  }
}

process.on('message', (request: WorkerRequest) => {
  void execute(request).then(
    (value) => {
      process.send?.({ id: request.id, ok: true, value } satisfies WorkerResponse, () => {
        if (request.action === 'close') process.disconnect();
      });
    },
    (error: unknown) => {
      process.send?.({
        id: request.id,
        ok: false,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      } satisfies WorkerResponse);
    },
  );
});

process.on('disconnect', () => {
  void authority?.close().catch(() => undefined);
});
