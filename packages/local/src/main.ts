import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { OUT_DIR_NAME } from '@stayingupwind/adapter';
import {
  builtinDeliveryPolicy,
  cspNonceModeSchema,
  type DeliveryPolicy,
  deliveryPolicySchema,
} from '@stayingupwind/host/delivery';

import { checkStack } from './check.ts';
import { environmentOf } from './environment.ts';
import type { LocalGate } from './gates.ts';
import { type CheckShard, parseCheckShard } from './sharding.ts';
import {
  type CspNonceSetting,
  deliveryPolicyRefusal,
  type LocalStack,
  startStack,
} from './stack.ts';

/**
 * A build served on this machine, from the directory `next build` left it in (`OUT_DIR_NAME`):
 *
 *   node src/main.ts serve --dir <app> [--port <port>] [<environment>]
 *       serve it until interrupted
 *   node src/main.ts check --dir <app> [--shard <index>/<total>] [<environment>]
 *       ask it once for every prerendered route, every file of the build and every app Function
 *
 * `<environment>` is any of `--env-file <file>`, which gives the application's Functions the
 * variables a `.env` file holds, as their deployment's environment would — a later file's value of
 * a name wins — and `--kv`, `--r2` and `--d1 <name>`, which bind an empty store of that kind under
 * the name given, for an application whose host gives it one. Each may be given more than once.
 * `--images` has the edge transform images, as an edge bound to Cloudflare Images does, on this
 * machine.
 *
 * A deployment it stands in for is served as its pointer has the edge serve it: under the delivery
 * policy it went live under (`--delivery-policy`, a built-in policy's id or a file holding one
 * registered), and with the nonce its site has the edge mint for each document (`--csp-nonce
 * enforce|report-only`, and `--csp-strict-dynamic` for `'strict-dynamic'` beside it). A check asks
 * as that deployment's validation asks: as its prover (`--prover-agent`), and naming the site by
 * the hostname it asks a candidate under (`--hostname`), the stack still reached at its own socket.
 *
 * A build that declares gates for its routes has the edge ask each where `--gate <name>=<url>`
 * says it answers, once for each gate (`StackOptions.gates`).
 */

/** The highest port a socket listens on. */
const MAX_PORT = 65_535;
const USAGE =
  'usage: main.ts serve|check --dir <app> [--port <port>] [--env-file <file>]… [--kv|--r2|--d1 <name>]… [--images] [--delivery-policy <id|file>] [--csp-nonce enforce|report-only [--csp-strict-dynamic]] [--prover-agent <agent>] [--hostname <host>] [--gate <name>=<url>]… [--shard <index>/<total> (check only)]';

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** A host as the command line names one: a URL's host, and nothing else of a URL, or `null`. */
function hostOf(value: string): string | null {
  if (/[\s#/?@]/u.test(value)) {
    return null;
  }
  try {
    return new URL(`https://${value}`).host;
  } catch {
    return null;
  }
}

/** A port as the command line names one: a whole number a socket listens on, or `null`. */
function portOf(value: string): number | null {
  const port = Number(value);
  return /^\d+$/u.test(value) && port <= MAX_PORT ? port : null;
}

/** The command line, as `parseArgs` reads it: it throws on an option it does not know, say. */
function commandLine() {
  return parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      port: { type: 'string' },
      'env-file': { type: 'string', multiple: true },
      kv: { type: 'string', multiple: true },
      r2: { type: 'string', multiple: true },
      d1: { type: 'string', multiple: true },
      images: { type: 'boolean' },
      // The agent a check asks as first, where a host's validation proves a build as its own.
      'prover-agent': { type: 'string' },
      'delivery-policy': { type: 'string' },
      // The hostname a check names the site by, where a host's validation asks under its own.
      hostname: { type: 'string' },
      shard: { type: 'string' },
      'csp-nonce': { type: 'string' },
      'csp-strict-dynamic': { type: 'boolean' },
      // Where each gate the build declares answers, as `<name>=<url>`.
      gate: { type: 'string', multiple: true },
    },
  });
}

/** The gates the command line names, each by `<name>=<url>`, or why one is not so named. */
function gatesOf(
  named: readonly string[],
): { readonly gates: Record<string, LocalGate> } | { readonly refused: string } {
  const gates: [string, LocalGate][] = [];
  for (const pair of named) {
    const at = pair.indexOf('=');
    if (at <= 0) {
      return { refused: `--gate ${pair} is to be <name>=<url>` };
    }
    gates.push([pair.slice(0, at), { url: pair.slice(at + 1) }]);
  }
  // As entries, each made the record's own: what a name may be is the stack's to judge.
  return { gates: Object.fromEntries(gates) };
}

/** What the command line asked of a deployment beside its build, or why it cannot be. */
type Served =
  | { readonly policy: DeliveryPolicy | undefined; readonly cspNonce: CspNonceSetting | undefined }
  | { readonly refused: string };

/** A policy by a built-in's id, or as a file holds one: the policy, or why it is none. */
function policyNamed(
  named: string,
): { readonly policy: DeliveryPolicy } | { readonly refused: string } {
  const builtin = builtinDeliveryPolicy(named);
  if (builtin !== undefined) {
    return { policy: builtin };
  }
  let text: string;
  try {
    text = readFileSync(named, 'utf8');
  } catch {
    return { refused: `--delivery-policy ${named} is no built-in policy's id, nor a file` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { refused: `${named} holds no delivery policy: it is not JSON` };
  }
  const policy = deliveryPolicySchema.safeParse(parsed);
  if (!policy.success) {
    return { refused: `${named} holds no delivery policy: ${policy.error.message}` };
  }
  // As a host registers one: under an id no built-in holds or will.
  const refused = deliveryPolicyRefusal(policy.data);
  return refused === undefined ? { policy: policy.data } : { refused: `${named}: ${refused}` };
}

/** The policy and the nonce setting the command line names, as a deployment's pointer names them. */
function servedOf(values: ReturnType<typeof commandLine>['values']): Served {
  const named = values['delivery-policy'];
  const chosen = named === undefined ? { policy: undefined } : policyNamed(named);
  if ('refused' in chosen) {
    return chosen;
  }
  const { policy } = chosen;
  const asked = values['csp-nonce'];
  const strictDynamic = values['csp-strict-dynamic'] === true;
  if (asked === undefined) {
    return strictDynamic
      ? {
          refused:
            "--csp-strict-dynamic puts 'strict-dynamic' beside a nonce: name one with --csp-nonce",
        }
      : { policy, cspNonce: undefined };
  }
  const mode = cspNonceModeSchema.safeParse(asked);
  return mode.success
    ? { policy, cspNonce: { mode: mode.data, strictDynamic } }
    : { refused: `--csp-nonce is enforce or report-only, not ${asked}` };
}

/** A check's requested share, refused before any deployment options are read. */
function shardOf(
  value: string | undefined,
  command: string | undefined,
): { readonly shard: CheckShard | undefined } | { readonly refused: string } {
  if (value === undefined) {
    return { shard: undefined };
  }
  const shard = parseCheckShard(value);
  return command === 'check' && shard !== null
    ? { shard }
    : { refused: '--shard needs index/total with 1 <= index <= total, and is only for check' };
}

/** What the command line asked of a deployment beside its build, its gates among it, or why not. */
type Asked =
  | (Exclude<Served, { readonly refused: string }> & {
      readonly gates: Record<string, LocalGate>;
      readonly shard: CheckShard | undefined;
    })
  | { readonly refused: string };

/** Validate the deployment options and check partition before starting a stack. */
function askedOf(
  values: ReturnType<typeof commandLine>['values'],
  command: string | undefined,
): Asked {
  const partition = shardOf(values.shard, command);
  if ('refused' in partition) {
    return partition;
  }
  const served = servedOf(values);
  if ('refused' in served) {
    return served;
  }
  const named = gatesOf(values.gate ?? []);
  return 'refused' in named ? named : { ...served, gates: named.gates, shard: partition.shard };
}

/** Run a local serve or check command and report its exit status. */
async function main(): Promise<number> {
  let parsed: ReturnType<typeof commandLine>;
  try {
    parsed = commandLine();
  } catch (error) {
    // An option it does not know, or one given without its value: said, with how it is used.
    log(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const { positionals, values } = parsed;
  const [command] = positionals;
  const port = values.port === undefined ? undefined : portOf(values.port);
  const hostname = values.hostname === undefined ? undefined : hostOf(values.hostname);
  const served = askedOf(values, command);
  if ('refused' in served) {
    log(`${served.refused}\n${USAGE}`);
    return 2;
  }
  if (
    port === null ||
    hostname === null ||
    values.dir === undefined ||
    positionals.length !== 1 ||
    (command !== 'serve' && command !== 'check')
  ) {
    log(USAGE);
    return 2;
  }
  let stack: LocalStack;
  try {
    stack = await startStack({
      bundleDir: path.resolve(values.dir, OUT_DIR_NAME),
      port,
      ...(hostname !== undefined && { hostnames: [hostname] }),
      env: environmentOf(values['env-file'] ?? []),
      storage: { kv: values.kv, r2: values.r2, d1: values.d1 },
      images: values.images,
      log,
      policy: served.policy,
      cspNonce: served.cspNonce,
      gates: served.gates,
    });
  } catch (error) {
    log(`the stack did not start: ${String(error)}`);
    return 1;
  }
  if (command === 'serve') {
    log(`serving ${stack.deploymentId} at ${stack.url.href}`);
    // Until interrupted: Miniflare stops its runtime on the signal.
    return new Promise(() => {
      // Never settles.
    });
  }
  try {
    const { checked, failures, skipped } = await checkStack(stack, {
      proverAgent: values['prover-agent'],
      hostname,
      shard: served.shard,
    });
    for (const { path: asked, reason } of skipped) {
      log(`${asked}: not judged, ${reason}`);
    }
    for (const { path: asked, reason } of failures) {
      log(`${asked}: ${reason}`);
    }
    log(`${stack.deploymentId}: ${checked - failures.length} of ${checked} answered as deployed`);
    return failures.length === 0 ? 0 : 1;
  } catch (error) {
    // The stack itself failed the check — its backstage, say — rather than an answer it judged.
    log(`${stack.deploymentId}: the check could not finish: ${String(error)}`);
    return 1;
  } finally {
    await stack.dispose();
  }
}

process.exitCode = await main();
