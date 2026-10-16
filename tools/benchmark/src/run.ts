import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';

import { agentFor, timeRequest } from './measure.ts';
import {
  pairsOf,
  planOf,
  PROTOCOL,
  type Run,
  type Sample,
  type Scenario,
  type ScenarioRun,
  SETTINGS,
  type Settings,
  type Side,
  TARGETS,
} from './protocol.ts';
import { nowIso } from './time.ts';

const REUSED: Scenario = 'reused-connection';

export interface Clock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<unknown>;
}

export async function runScenario(
  scenario: Scenario,
  settings: Settings,
  time: (side: Side) => Promise<Sample>,
  clock: Clock,
): Promise<ScenarioRun> {
  const plan = planOf(settings);
  const deadline = clock.now() + settings.budgetMs;
  const samples: Sample[] = [];
  for (const [index, step] of plan.entries()) {
    if (index > 0 && clock.now() < deadline) {
      await clock.sleep(settings.spacingMs);
    }
    if (clock.now() >= deadline) {
      break;
    }
    samples.push(await time(step.side));
  }
  return { scenario, truncated: samples.length < plan.length, pairs: pairsOf(plan, samples) };
}

export async function measureRun(): Promise<Run> {
  const startedAt = nowIso();
  const scenarios: ScenarioRun[] = [];
  const clock: Clock = { now: () => performance.now(), sleep: setTimeout };
  const names: Scenario[] = ['new-connection', REUSED];
  for (const scenario of names) {
    const agents = {
      vercel: agentFor(scenario === REUSED),
      arkor: agentFor(scenario === REUSED),
    };
    try {
      const run = await runScenario(
        scenario,
        SETTINGS,
        (side) => timeRequest(TARGETS[side], agents[side], SETTINGS.timeoutMs),
        clock,
      );
      scenarios.push(run);
    } finally {
      agents.vercel.destroy();
      agents.arkor.destroy();
    }
  }
  return {
    protocol: PROTOCOL,
    vantage: 'github',
    location: null,
    startedAt,
    finishedAt: nowIso(),
    targets: TARGETS,
    settings: SETTINGS,
    scenarios,
  };
}
