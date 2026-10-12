import {
  type ApplyResourceChangeInput,
  applyResourceChangeInputSchema,
  type ApplyResourceChangeResult,
  type CacheNaming,
  type FinishResourceWarmJobInput,
  finishResourceWarmJobInputSchema,
  type FinishResourceWarmJobResult,
  type InvalidateScopeInput,
  invalidateScopeInputSchema,
  issueTokenInputSchema,
  type ListResourceWarmJobsInput,
  listResourceWarmJobsInputSchema,
  type ListResourceWarmJobsResult,
  type RetireScopeInput,
  type RetireScopeResult,
  retireScopeInputSchema,
  type SeedEntriesInput,
  type SeedEntriesResult,
  seedEntriesInputSchema,
  type SeedScopeInput,
  type SeedScopeResult,
  seedScopeInputSchema,
  signCacheToken,
} from '@stayingupwind/host/cache';
import { WorkerEntrypoint } from 'cloudflare:workers';

import { announceBehind } from '../announce.ts';
import type { AuthorityHost } from '../authority-host.ts';
import type { CacheBindings } from '../bindings.ts';
import { type CacheVars, parseVars } from '../env.ts';
import { isRefusal } from '../scope/state.ts';
import { scopeStub } from '../scope/stub.ts';

/**
 * The token a scope's Workers present to the gateways, signed with the key only this Worker holds,
 * under the host's label (`AuthorityHost.naming`).
 */
export function scopeToken(env: CacheVars, scopeId: string, naming: CacheNaming): Promise<string> {
  const key = parseVars(env).CACHE_TOKEN_KEY;
  if (key === undefined) {
    throw new Error('CACHE_TOKEN_KEY is not configured: no scope can be opened');
  }
  return signCacheToken(key, scopeId, naming);
}

/**
 * The authority as a host's deploy reaches it, over a service binding, under what the host decided
 * for it: a class to export as an entrypoint, or to extend with the host's own. Every argument is
 * checked against the contract on the way in: the caller is trusted, its serialization is not. The
 * token a seeded scope answers with is signed here.
 */
export function cacheControl(authority: AuthorityHost): CacheControlClass {
  return class extends WorkerEntrypoint<CacheBindings> implements CacheControl {
    async seedScope(input: SeedScopeInput): Promise<SeedScopeResult> {
      const parsed = seedScopeInputSchema.parse(input);
      const { scopeId } = parsed.scope;
      // Signed before the scope is seeded: a token that cannot be signed — no key, or a label or a
      // scope the signature cannot carry — refuses the seed, rather than failing the answer to one
      // committed, which every retry would find seeded and fail to answer again.
      const token = await scopeToken(this.env, scopeId, authority.naming);
      const result = await scopeStub(this.env, scopeId, authority.locationHint).seedScope(
        parsed,
        Date.now(),
      );
      return result.kind === 'conflict' ? result : { ...result, token };
    }

    /**
     * Invalidate a scope's tags as the host asks, without a token of the deployment's, announced
     * behind the answer (`announceBehind`): an unseeded or retired scope is left as it is, and any
     * other refusal rejects.
     */
    async invalidateScope(input: InvalidateScopeInput): Promise<void> {
      const parsed = invalidateScopeInputSchema.parse(input);
      const result = await scopeStub(this.env, parsed.scopeId, authority.locationHint).invalidate(
        parsed.request,
        Date.now(),
        'control',
      );
      if (!isRefusal(result)) {
        announceBehind(authority, parsed.scopeId, this.env, (work) => {
          this.ctx.waitUntil(work);
        });
      } else if (result.code !== 'not_found' && result.code !== 'scope_retired') {
        throw new Error(`invalidation refused (${result.code}): ${result.message}`);
      }
    }

    async seedEntries(input: SeedEntriesInput): Promise<SeedEntriesResult> {
      const parsed = seedEntriesInputSchema.parse(input);
      const result = await scopeStub(this.env, parsed.scopeId, authority.locationHint).seedEntries(
        parsed,
        Date.now(),
      );
      if (isRefusal(result)) {
        throw new Error(`seeding refused (${result.code}): ${result.message}`);
      }
      return result;
    }

    async retireScope(input: RetireScopeInput): Promise<RetireScopeResult> {
      const parsed = retireScopeInputSchema.parse(input);
      return scopeStub(this.env, parsed.scopeId, authority.locationHint).retire(
        parsed.reason,
        Date.now(),
      );
    }

    async issueToken(input: { scopeId: string }): Promise<{ token: string }> {
      const parsed = issueTokenInputSchema.parse(input);
      return { token: await scopeToken(this.env, parsed.scopeId, authority.naming) };
    }

    /**
     * Apply a resource's change to the scope; one that moved the resource's tag is announced behind
     * the answer, as an invalidation is (`announceBehind`). One applied already, reconciled or not,
     * moved no tag.
     */
    async applyResourceChange(input: ApplyResourceChangeInput): Promise<ApplyResourceChangeResult> {
      const parsed = applyResourceChangeInputSchema.parse(input);
      const result = await scopeStub(
        this.env,
        parsed.scopeId,
        authority.locationHint,
      ).applyResourceChange(parsed, Date.now());
      if (!isRefusal(result)) {
        if (result.kind === 'applied') {
          announceBehind(authority, parsed.scopeId, this.env, (work) => {
            this.ctx.waitUntil(work);
          });
        }
        return result;
      }
      if (result.code === 'not_found' || result.code === 'scope_retired') {
        return {
          kind: 'unavailable',
          reason: result.code === 'not_found' ? 'unknown' : 'retired',
        };
      }
      throw new Error(`resource change refused (${result.code}): ${result.message}`);
    }

    async listResourceWarmJobs(
      input: ListResourceWarmJobsInput,
    ): Promise<ListResourceWarmJobsResult> {
      const parsed = listResourceWarmJobsInputSchema.parse(input);
      return scopeStub(this.env, parsed.scopeId, authority.locationHint).listResourceWarmJobs(
        parsed,
        Date.now(),
      );
    }

    async finishResourceWarmJob(
      input: FinishResourceWarmJobInput,
    ): Promise<FinishResourceWarmJobResult> {
      const parsed = finishResourceWarmJobInputSchema.parse(input);
      return scopeStub(this.env, parsed.scopeId, authority.locationHint).finishResourceWarmJob(
        parsed,
        Date.now(),
      );
    }
  };
}

/** The entrypoint class `cacheControl` makes: one the runtime constructs, as it does any. */
export type CacheControlClass = new (
  ctx: ExecutionContext,
  env: CacheBindings,
) => CacheControl & WorkerEntrypoint<CacheBindings>;

/** What a host's deploy may ask of the authority (`cacheControl`). */
interface CacheControl {
  seedScope(input: SeedScopeInput): Promise<SeedScopeResult>;
  invalidateScope(input: InvalidateScopeInput): Promise<void>;
  seedEntries(input: SeedEntriesInput): Promise<SeedEntriesResult>;
  retireScope(input: RetireScopeInput): Promise<RetireScopeResult>;
  issueToken(input: { scopeId: string }): Promise<{ token: string }>;
  applyResourceChange(input: ApplyResourceChangeInput): Promise<ApplyResourceChangeResult>;
  listResourceWarmJobs(input: ListResourceWarmJobsInput): Promise<ListResourceWarmJobsResult>;
  finishResourceWarmJob(input: FinishResourceWarmJobInput): Promise<FinishResourceWarmJobResult>;
}
