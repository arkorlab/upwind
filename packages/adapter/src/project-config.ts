import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { type CronJob, cronsSchema } from '@stayingupwind/core/cron';
import { parse as parseJsonc, type ParseError, printParseErrorCode } from 'jsonc-parser';
import { z } from 'zod';

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

export interface ProjectConfig {
  /** The file the configuration came from, relative to the project directory; for messages. */
  readonly file: string | undefined;
  readonly crons: readonly CronJob[];
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

function configError(file: string, detail: string): Error {
  return new Error(`@stayingupwind/adapter: ${file}: ${detail}`);
}

/** Zod's issues, as one line per issue naming where in the file it was. */
function describeIssues(error: z.ZodError): string {
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
async function findConfigFile(
  projectDir: string,
  names: readonly string[],
): Promise<string | undefined> {
  for (const name of names) {
    if (await exists(path.join(projectDir, name))) {
      return name;
    }
  }
  return undefined;
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
  const file = await findConfigFile(projectDir, configFileOrder(hostConfigFiles));
  if (file === undefined) {
    return EMPTY_PROJECT_CONFIG;
  }
  const absolute = path.join(projectDir, file);
  const value = file.endsWith('.ts')
    ? await importConfigModule(file, absolute)
    : parseJsonFile(file, await readFile(absolute, 'utf8'), file.endsWith('.jsonc'));
  const parsed = projectConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw configError(file, describeIssues(parsed.error));
  }
  return { file, crons: parsed.data.crons ?? [] };
}
