import { randomBytes } from 'node:crypto';

import {
  CreateRuleCommand,
  DeleteRuleCommand,
  DescribeRulesCommand,
  DescribeTagsCommand,
  DescribeTargetHealthCommand,
  ModifyRuleCommand,
  type Rule,
} from '@aws-sdk/client-elastic-load-balancing-v2';

import type { AwsContext } from './sdk.ts';
import { errorCode, mutation, UncertainAwsMutation } from './sdk.ts';
import type { ProjectLock } from './state.ts';

const PRODUCTION_PRIORITY = 50_000;
export const PROBE_HEADER = 'x-upwind-probe';

export async function listenerRules(context: AwsContext, listener: string): Promise<Rule[]> {
  const found: Rule[] = [];
  let marker: string | undefined;
  do {
    const page = await context.services.loadBalancer.send(
      new DescribeRulesCommand({
        ListenerArn: listener,
        ...(marker === undefined ? {} : { Marker: marker }),
      }),
    );
    found.push(...(page.Rules ?? []));
    marker = page.NextMarker;
  } while (marker !== undefined);
  return found;
}

export function probeIdentity(rules: readonly Rule[]): {
  readonly token: string;
  readonly priority: number;
} {
  const taken = new Set(rules.map((rule) => Number(rule.Priority)));
  for (let priority = 10; priority < PRODUCTION_PRIORITY; priority += 1) {
    if (!taken.has(priority)) return { token: randomBytes(32).toString('hex'), priority };
  }
  throw new Error('the ALB listener has no room for another deployment probe rule');
}

export function targetOf(rule: Rule | undefined): string | undefined {
  return rule?.Actions?.find((action) => action.Type === 'forward')?.TargetGroupArn;
}

export async function productionRule(
  context: AwsContext,
  listener: string,
  project: string,
): Promise<Rule | undefined> {
  const rule = (await listenerRules(context, listener)).find(
    (candidate) => candidate.Priority === String(PRODUCTION_PRIORITY),
  );
  if (rule?.RuleArn === undefined) return undefined;
  const tags = await context.services.loadBalancer.send(
    new DescribeTagsCommand({ ResourceArns: [rule.RuleArn] }),
  );
  if (
    !tags.TagDescriptions?.[0]?.Tags?.some(
      (tag) => tag.Key === 'upwind:project' && tag.Value === project,
    )
  )
    throw new Error('ALB production priority belongs to another owner');
  return rule;
}

export async function switchProduction(
  context: AwsContext,
  input: {
    listener: string;
    project: string;
    target: string;
    expectedTarget?: string;
    lock: ProjectLock;
  },
): Promise<string> {
  await input.lock.assertHeld();
  const previous = await productionRule(context, input.listener, input.project);
  if (targetOf(previous) !== input.expectedTarget)
    throw new Error('ALB production routing changed; no traffic was switched');
  const actions = [{ Type: 'forward' as const, TargetGroupArn: input.target }];
  let arn = previous?.RuleArn;
  if (arn === undefined) {
    const result = await mutation('create production ALB rule', () =>
      context.services.loadBalancer.send(
        new CreateRuleCommand({
          ListenerArn: input.listener,
          Priority: PRODUCTION_PRIORITY,
          Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/*'] } }],
          Actions: actions,
          Tags: [{ Key: 'upwind:project', Value: input.project }],
        }),
      ),
    );
    arn = result.Rules?.[0]?.RuleArn;
  } else {
    await mutation('switch production ALB rule', () =>
      context.services.loadBalancer.send(new ModifyRuleCommand({ RuleArn: arn, Actions: actions })),
    );
  }
  const actual = await productionRule(context, input.listener, input.project).catch(
    (error: unknown) => {
      throw new UncertainAwsMutation('ALB production switch could not be read back', error);
    },
  );
  if (arn === undefined || actual?.RuleArn !== arn || targetOf(actual) !== input.target)
    throw new UncertainAwsMutation(
      'ALB production switch is unconfirmed; no retained deployment was removed',
      undefined,
    );
  return arn;
}

export async function removeProduction(
  context: AwsContext,
  listener: string,
  project: string,
  lock: ProjectLock,
): Promise<void> {
  await lock.assertHeld();
  const rule = await productionRule(context, listener, project).catch((error: unknown) => {
    if (errorCode(error) === 'ListenerNotFoundException' || errorCode(error) === 'ListenerNotFound')
      return undefined;
    throw error;
  });
  if (rule?.RuleArn !== undefined)
    await mutation('delete production ALB rule', () =>
      context.services.loadBalancer.send(new DeleteRuleCommand({ RuleArn: rule.RuleArn })),
    );
}

export async function checkDeployment(
  context: AwsContext,
  input: {
    target: string;
    tasks: number;
    origin: string;
    token?: string;
    deploymentId: string;
    checks: readonly string[];
  },
): Promise<void> {
  const deadline = context.now() + 300_000;
  let ready = false;
  while (context.now() < deadline) {
    const health = await context.services.loadBalancer.send(
      new DescribeTargetHealthCommand({ TargetGroupArn: input.target }),
    );
    if (
      (health.TargetHealthDescriptions ?? []).filter(
        (target) => target.TargetHealth?.State === 'healthy',
      ).length >= input.tasks
    ) {
      ready = true;
      break;
    }
    await context.sleep(5000);
  }
  if (!ready)
    throw new Error('the deployment did not reach its required number of healthy Fargate tasks');
  const headers = new Headers({ 'cache-control': 'no-store' });
  if (input.token !== undefined) headers.set(PROBE_HEADER, input.token);
  let last: unknown;
  while (context.now() < deadline) {
    try {
      const health = await context.fetch(new URL('/__upwind/health', input.origin), {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
      const body: unknown = await health.json();
      if (
        health.status !== 200 ||
        typeof body !== 'object' ||
        body === null ||
        !('deploymentId' in body) ||
        body.deploymentId !== input.deploymentId
      )
        throw new Error('readiness did not identify the requested deployment');
      for (const path of input.checks) {
        const response = await context.fetch(new URL(path, input.origin), {
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        });
        await response.body?.cancel();
        if (response.status < 200 || response.status >= 400)
          throw new Error(`deployment check ${path} returned ${String(response.status)}`);
      }
      return;
    } catch (error) {
      last = error;
      await context.sleep(5000);
    }
  }
  throw new Error(
    `the candidate deployment failed readiness/checks: ${last instanceof Error ? last.message : String(last)}`,
  );
}
