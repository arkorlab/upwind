/** The experiment is independent of the tools and platforms that read its public results. */
export const PROTOCOL = 2;
export const TARGETS = {
  vercel: 'https://stayingupwind.vercel.app/',
  arkor: 'https://arkorlab-upwind.arkor.app/',
} as const;

export const SETTINGS = {
  pairs: 30,
  warmup: 20,
  spacingMs: 25,
  timeoutMs: 4000,
  budgetMs: 16_000,
} as const;

export const REQUEST_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-encoding': 'gzip, deflate, br, zstd',
  'accept-language': 'en',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'user-agent': 'arkor-benchmark/1.0 (+https://www.arkor.dev/benchmark)',
} as const;

export type Side = keyof typeof TARGETS;
export type Scenario = 'new-connection' | 'reused-connection';
export interface Settings {
  readonly pairs: number;
  readonly warmup: number;
  readonly spacingMs: number;
  readonly timeoutMs: number;
  readonly budgetMs: number;
}

export interface Sample {
  readonly status: number;
  readonly error?: string;
  readonly headersMs: number | null;
  readonly firstByteMs: number | null;
  readonly completeMs: number | null;
  readonly bytes: number | null;
  readonly markers: Readonly<Record<string, string>>;
  readonly connection: {
    readonly dnsMs: number | null;
    readonly connectMs: number | null;
    readonly tlsMs: number | null;
    readonly reused: boolean;
  };
}

export interface Pair {
  readonly first: Side;
  readonly vercel: Sample;
  readonly arkor: Sample;
}

export interface ScenarioRun {
  readonly scenario: Scenario;
  readonly truncated: boolean;
  readonly pairs: readonly Pair[];
}

export interface Run {
  readonly protocol: number;
  readonly vantage: 'github' | 'local';
  readonly location: null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly targets: Readonly<Record<Side, string>>;
  readonly settings: Settings;
  readonly scenarios: readonly ScenarioRun[];
}

const MAX_TEXT = 200;

export function boundedText(value: string): string {
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value;
}

export function errorText(error: unknown): string {
  return boundedText(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
}

export function failedSample(error: string): Sample {
  return {
    status: 0,
    error,
    headersMs: null,
    firstByteMs: null,
    completeMs: null,
    bytes: null,
    markers: {},
    connection: { dnsMs: null, connectMs: null, tlsMs: null, reused: false },
  };
}

export interface Step {
  readonly side: Side;
  readonly warmup: boolean;
}

export function planOf(settings: Settings): Step[] {
  const plan: Step[] = [];
  for (let round = 0; round < settings.warmup + settings.pairs; round += 1) {
    const pair = round < settings.warmup ? round : round - settings.warmup;
    const sides: Side[] = pair % 2 === 0 ? ['vercel', 'arkor'] : ['arkor', 'vercel'];
    for (const side of sides) {
      plan.push({ side, warmup: round < settings.warmup });
    }
  }
  return plan;
}

export function pairsOf(plan: readonly Step[], samples: readonly Sample[]): Pair[] {
  const pairs: Pair[] = [];
  for (let index = 0; index < samples.length; index += 2) {
    const step = plan[index];
    const first = samples[index];
    if (first === undefined || step === undefined || step.warmup) {
      continue;
    }
    const second = samples[index + 1] ?? failedSample('not made: the budget ran out first');
    pairs.push(
      step.side === 'vercel'
        ? { first: step.side, vercel: first, arkor: second }
        : { first: step.side, arkor: first, vercel: second },
    );
  }
  return pairs;
}
