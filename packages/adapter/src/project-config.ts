import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { type CronJob, cronsSchema } from '@stayingupwind/core/cron';
import * as z from '@stayingupwind/core/schema';
import { parse as parseJsonc, type ParseError, printParseErrorCode } from 'jsonc-parser';

import { exists } from './fs.ts';

/**
 * What a project declares about its deployment beyond `next.config`.
 *
 * Next.js's adapter API hands the adapter the build's outputs and its config, and nothing else: a
 * cron job is not something `next build` knows about, so it is read from a file of the project's
 * own. Four are looked for, in this order, and **the first one that exists is the only one read**:
 *
 * | File               | Why it is here                                                         |
 * | ------------------ | ---------------------------------------------------------------------- |
 * | `upwind.config.ts` | this adapter's own, typed, and able to compute what it declares         |
 * | `upwind.jsonc`     | the same, with comments — the shape `wrangler.jsonc` has                |
 * | `upwind.json`      | the same, plain                                                        |
 * | `vercel.json`      | what a project moving here already has                                 |
 *
 * The first that exists wins whole; the files are not merged. Merging would mean deciding which
 * file wins a key neither of them meant to share, and nothing here guesses: a project with both
 * an `upwind.json` and a `vercel.json` is one that has moved, and what it declares to this
 * adapter is in the file named after it.
 *
 * Only `crons` is read from `vercel.json`. The rest of that file is Vercel's deployment
 * configuration — rewrites, headers, redirects, regions — and those are taken from `next.config`,
 * where Next.js resolves them and where the build already records them. Reading them twice, from
 * two files with two sets of semantics, is how a deployment comes to serve something neither file
 * describes.
 */

/** Read in this order; the first that exists is the one read. */
export const CONFIG_FILES = [
  'upwind.config.ts',
  'upwind.jsonc',
  'upwind.json',
  'vercel.json',
] as const;
const VERCEL_CONFIG = 'vercel.json';

/**
 * The names this build looks for, in order: this adapter's own, then any the host still answers to,
 * then `vercel.json`.
 *
 * A host that once read the same file under a different name has projects that wrote it, and a
 * build that stopped looking would read no configuration at all from them — which is not nothing
 * but an empty one: the crons such a project declared would be taken as withdrawn and its schedule
 * dropped. Its names go after this adapter's, which is what makes them the older spelling rather
 * than a second way to say the same thing, and before `vercel.json`, where a platform's own file
 * has always come.
 */
export function configFileOrder(hostConfigFiles: readonly string[] = []): readonly string[] {
  const own = CONFIG_FILES.filter((name) => name !== VERCEL_CONFIG);
  return [...own, ...hostConfigFiles, VERCEL_CONFIG];
}

/**
 * What a project asks of how its routes are spread across Functions (`AdapterOptions.functions`):
 * `false` keeps every route in one, whatever it weighs; `true` asks for the split on the host's
 * budgets; an object asks for it on budgets of its own, which can only be tighter than the host's.
 */
export type ProjectSplit =
  | boolean
  | { readonly maxMiB?: number | undefined; readonly maxCodeMiB?: number | undefined };

export interface ProjectConfig {
  /** The file the configuration came from, relative to the project directory; for messages. */
  readonly file: string | undefined;
  readonly crons: readonly CronJob[];
  /** Read from this adapter's own files and a host's, never from `vercel.json`. */
  readonly split?: ProjectSplit | undefined;
  /**
   * How `upwind deploy` puts the project on a Cloudflare account of its own (`deploySchema`). The
   * build reads none of it: it is here so that the one file a project configures upwind in, read
   * the one way this reads it, says both.
   */
  readonly deploy?: DeployConfig | undefined;
}

const EMPTY_PROJECT_CONFIG: ProjectConfig = { file: undefined, crons: [] };

/**
 * The keys this adapter reads today.
 *
 * Unknown keys are ignored rather than refused: a `vercel.json` is full of keys that are none of
 * this adapter's business, and an `upwind.json` written against a later version should not fail a
 * build on the one key this version has never heard of. What is *known* is validated strictly — a
 * cron with a schedule that cannot be run fails the build here rather than silently never
 * firing.
 */
const projectConfigSchema = z.object({
  crons: cronsSchema.optional(),
});

/**
 * `functions`, which only this adapter's own files carry. `vercel.json` has a `functions` too, and
 * there it is Vercel's per-file settings — memory, duration, regions — keyed by glob: read through
 * this schema it would fail the build of every project that moved here with one. So it is not read
 * from that file at all, and a budget a project writes in its own file is held to exactly these
 * keys, since a misspelled one would be a budget silently not applied.
 */
const splitBudgetSchema = z
  .object({
    maxMiB: z.number().positive().optional(),
    maxCodeMiB: z.number().positive().optional(),
  })
  .strict();
const functionsSchema = z.object({ split: z.union([z.boolean(), splitBudgetSchema]).optional() });

/**
 * A project's name on its Cloudflare account: the prefix of every Worker, namespace and bucket
 * `upwind deploy` makes for it. Short enough that a Function's Worker — this, the deployment's
 * 25-character label and a role — is still one DNS label of 63 characters, which is what a
 * `workers.dev` hostname needs a Worker's name to be; lowercase, since a hostname is.
 */
const DEPLOY_NAME = /^[a-z](?:[a-z\d]|-(?!-)){0,22}[a-z\d]$/u;
/** A hostname as the edge is reached on it: lowercase labels, at least two of them. */
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/u;
/** A binding an application reads, as a Function's environment names it. */
const BINDING_NAME = /^[A-Za-z_$][\w$]{0,63}$/u;
/** A variable's name, as an environment carries one. */
const VARIABLE_NAME = /^[A-Za-z_]\w{0,127}$/u;
/** How many old deployments a project may keep to roll back to; each costs its Functions' Workers. */
const MAX_KEPT_DEPLOYMENTS = 50;
/** How many hostnames, secrets and checks a project may list: far past any one project's. */
const MAX_HOSTNAMES = 100;
const MAX_SECRETS = 100;
const MAX_CHECKS = 20;
/** A path long enough for any route with its parameters filled in, as a cron's may be. */
const MAX_CHECK_PATH_LENGTH = 512;

const hostnameSchema = z.string().regex(HOSTNAME);
const bindingNameSchema = z.string().regex(BINDING_NAME);
const variableNameSchema = z.string().regex(VARIABLE_NAME);
const storageKindSchema = z.union([z.literal('d1'), z.literal('kv'), z.literal('r2')]);
const nonceModeSchema = z.union([z.literal('enforce'), z.literal('report-only')]);

/**
 * A path a check requests: from `/`, printable ASCII, and never `//`, which a URL reads as a host
 * — the same rule a cron job's path is held to, for the same reason.
 */
const checkPathSchema = z
  .string()
  .max(MAX_CHECK_PATH_LENGTH)
  .regex(/^\/[\u{21}-\u{7E}]*$/u, 'expected a path beginning with "/"')
  .refine((checked) => !checked.startsWith('//'), 'expected a path, not a protocol-relative URL');

/**
 * `deploy`: how `upwind deploy` puts the project on a Cloudflare account of its own. Only this
 * adapter's own files carry it, and every key is held to exactly what is written here: a misspelled
 * one would be a setting a deployment silently went without.
 *
 * The storage an application is given is named here, never guessed from its code. A binding listed
 * is made on the account, under the project's name, and bound to every Function of every
 * deployment; one that is not listed is not there, whatever the code reads.
 */
const deploySchema = z
  .object({
    /** The project's name on the account; the package's own name, made to fit, when absent. */
    name: z.string().regex(DEPLOY_NAME).optional(),
    /** Whether the edge answers on its `workers.dev` name; it does unless this says no. */
    workersDev: z.boolean().optional(),
    /** Every other hostname a route or a custom domain sends to the edge, attached by hand. */
    hostnames: z.array(hostnameSchema).max(MAX_HOSTNAMES).optional(),
    /** How many deployments before the live one stay ready to roll back to. */
    keep: z.number().int().min(0).max(MAX_KEPT_DEPLOYMENTS).optional(),
    /** The storage every Function is bound to, by binding name: a database, a namespace, a bucket. */
    storage: z.record(bindingNameSchema, storageKindSchema).optional(),
    /** Variables read from the environment on every deploy and given to every Function, as secrets. */
    secrets: z.array(variableNameSchema).max(MAX_SECRETS).optional(),
    /** Whether `next/image` is given Cloudflare Images; it is not unless this says so. */
    images: z.boolean().optional(),
    /** What a new deployment is asked for before it is made the live one; `/` when absent. */
    checks: z.array(checkPathSchema).min(1).max(MAX_CHECKS).optional(),
    /** A nonce the edge mints for each document, as a deployment's policy would carry one. */
    cspNonce: z
      .object({ mode: nonceModeSchema.optional(), strictDynamic: z.boolean().optional() })
      .strict()
      .optional(),
    /** Whether Cloudflare keeps the Functions' logs; it does not unless this says so. */
    logs: z.boolean().optional(),
  })
  .strict();

/** What `upwind deploy` reads of a project's configuration, as `deploySchema` reads it. */
export type DeployConfig = z.infer<typeof deploySchema>;

const upwindConfigSchema = projectConfigSchema.extend({
  functions: functionsSchema.optional(),
  deploy: deploySchema.optional(),
});

/**
 * The shape a project's own configuration is written in — `upwind.config.ts`, `upwind.jsonc`,
 * `upwind.json`, or a name its host reads (`configFileOrder`): the input of the schema those files
 * are read with, so that the type and the reader cannot drift apart. A config that exports a
 * function returns one of these, or a promise of one.
 *
 * Meant for a type-only import (`import type`, then `satisfies UpwindConfig`), which Node strips
 * with the rest of the types: the file still needs nothing of this package when the build
 * evaluates it. The type differs from the reader in two ways. A key it does not name fails
 * `satisfies`, where the build ignores it, because checked against this version that key is one
 * this version does not read. And it is the shape alone: what a type cannot say, the reader still
 * checks when the build reads the file — that each path is one (from `/` but not `//`, printable
 * ASCII, at most 512 characters), that each schedule can be run, that there are no more than
 * `MAX_CRONS_PER_PROJECT` jobs and no path twice on one schedule, and that a budget is positive.
 *
 * It resolves only where this package resolves to its TypeScript sources, as in a workspace. The
 * published package ships its `dist` as JavaScript alone, with no declarations, so a project that
 * installed it from the registry cannot import the type until it ships some.
 */
export type UpwindConfig = z.input<typeof upwindConfigSchema>;

function configError(file: string, detail: string): Error {
  return new Error(`@stayingupwind/adapter: ${file}: ${detail}`);
}

/** The issues, as one line per issue naming where in the file it was. */
function describeIssues(error: z.SchemaError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
      return `${at}${issue.message}`;
    })
    .join('; ');
}

function describeJsoncErrors(errors: readonly ParseError[]): string {
  return errors
    .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
    .join('; ');
}

/**
 * A JSON file, with comments and trailing commas where the name says so.
 *
 * `jsonc-parser` is asked for its errors rather than left to recover from them: a comma it healed
 * over is a line the author wrote and the build ignored.
 */
function parseJsonFile(file: string, source: string, jsonc: boolean): unknown {
  if (!jsonc) {
    try {
      return JSON.parse(source);
    } catch (error) {
      throw configError(file, error instanceof Error ? error.message : String(error));
    }
  }
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    throw configError(file, describeJsoncErrors(errors));
  }
  return value;
}

/**
 * A TypeScript config, evaluated by Node itself.
 *
 * Node strips the types off a `.ts` file outside `node_modules` (24.x; the builder image pins the
 * same version), so the file needs no build step of its own and may import whatever the project
 * can. It has to be erasable syntax — no `enum`, no parameter properties — which is what Node
 * refuses, in its own words, and the build stops there.
 */
async function importConfigModule(file: string, absolute: string): Promise<unknown> {
  let module: { default?: unknown };
  try {
    module = (await import(pathToFileURL(absolute).href)) as { default?: unknown };
  } catch (error) {
    throw configError(file, error instanceof Error ? error.message : String(error));
  }
  if (module.default === undefined) {
    throw configError(file, 'expected a default export');
  }
  if (typeof module.default !== 'function') {
    return module.default;
  }
  // A config may export a function of no arguments, so that what it declares can be computed —
  // and whatever that computation throws is this file's failure, named as this file's.
  try {
    return await (module.default as () => unknown)();
  } catch (error) {
    throw configError(file, error instanceof Error ? error.message : String(error));
  }
}

/** Where the platform's configuration for this build is, if the project wrote one. */
export async function findProjectConfigFile(
  projectDir: string,
  hostConfigFiles: readonly string[] = [],
): Promise<string | undefined> {
  for (const name of configFileOrder(hostConfigFiles)) {
    if (await exists(path.join(projectDir, name))) {
      return name;
    }
  }
  return undefined;
}

/** The selected file's unvalidated value, for tools that read additional project settings. */
export interface ProjectConfigFile {
  readonly file: string | undefined;
  readonly value: unknown;
}

/** Read the same single file as the adapter, including Node-evaluated TypeScript exports. */
export async function readProjectConfigFile(
  projectDir: string,
  hostConfigFiles: readonly string[] = [],
): Promise<ProjectConfigFile> {
  const file = await findProjectConfigFile(projectDir, hostConfigFiles);
  if (file === undefined) return { file: undefined, value: {} };
  const absolute = path.join(projectDir, file);
  const value = file.endsWith('.ts')
    ? await importConfigModule(file, absolute)
    : parseJsonFile(file, await readFile(absolute, 'utf8'), file.endsWith('.jsonc'));
  return { file, value };
}

/**
 * Read the project's configuration, or the empty one when it wrote none.
 *
 * Throws with the file's name on anything it cannot read or cannot honour: the build is where a
 * declaration is refused, because the alternative is a deployment whose cron jobs quietly never
 * fire.
 */
export async function readProjectConfig(
  projectDir: string,
  hostConfigFiles: readonly string[] = [],
): Promise<ProjectConfig> {
  const { file, value } = await readProjectConfigFile(projectDir, hostConfigFiles);
  if (file === undefined) {
    return EMPTY_PROJECT_CONFIG;
  }
  if (file === VERCEL_CONFIG) {
    const parsed = projectConfigSchema.safeParse(value);
    if (!parsed.success) {
      throw configError(file, describeIssues(parsed.error));
    }
    return { file, crons: parsed.data.crons ?? [] };
  }
  const parsed = upwindConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw configError(file, describeIssues(parsed.error));
  }
  const split = parsed.data.functions?.split;
  const { deploy } = parsed.data;
  return {
    file,
    crons: parsed.data.crons ?? [],
    ...(split !== undefined && { split }),
    ...(deploy !== undefined && { deploy }),
  };
}
