import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

/**
 * The files Next.js's route modules read from disk at request time, as `(name, contents)` pairs
 * to ship as text modules. Inside the Worker they are read back through the virtual file system
 * at `/bundle/<name>`, which is why their names keep the `.next/...` layout.
 */
export interface TextModule {
  readonly name: string;
  readonly contents: string;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else {
      out.push(full);
    }
  }
  return out;
}

/**
 * A client reference manifest is a script that assigns into `globalThis.__RSC_MANIFEST`. Next.js
 * evaluates it at request time with `node:vm`, in a fresh context that holds only
 * `process.env.NEXT_DEPLOYMENT_ID`, and reads the manifest back off that context. The adapter
 * runs the very same evaluation here, at build time, with the deployment id the Worker will be
 * given, and ships the whole context as JSON: the patched loader assigns it into its own
 * context instead of evaluating (see `patches/load-manifest.ts`). Nothing about the script's
 * shape is assumed — Turbopack has more than one template — only that its result is JSON.
 */
export function evaluateManifestScript(source: string, deploymentId: string, file: string): string {
  if (source.length === 0) {
    // What Next.js itself throws for an empty manifest (E328).
    throw new Error(`@upwind/adapter: manifest file is empty: ${file}`);
  }
  const contextObject: Record<string, unknown> = {
    process: { env: { NEXT_DEPLOYMENT_ID: deploymentId } },
  };
  // eslint-disable-next-line sonarjs/code-eval -- the evaluation Next.js does at request time, done once here
  runInNewContext(source, contextObject, { filename: file });
  assertJson(contextObject, file, '');
  return JSON.stringify(contextObject);
}

const PLAIN_OBJECT = '[object Object]';

/**
 * Fail on anything JSON would drop or alter — `undefined`, a function, a symbol, a bigint, an
 * infinite number, a `Date`, a `Map`, a cycle — rather than ship a manifest that differs from
 * what Next.js would have read. Values come from another realm, so their prototypes cannot be
 * compared with this one's; the tag `Object.prototype.toString` gives is realm-independent.
 */
function assertJson(value: unknown, file: string, at: string, seen = new Set<unknown>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`@upwind/adapter: ${file}: ${at || '.'} is ${value}, not JSON`);
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`@upwind/adapter: ${file}: ${at || '.'} is ${typeof value}, not JSON`);
  }
  if (seen.has(value)) {
    throw new TypeError(`@upwind/adapter: ${file}: ${at || '.'} is part of a cycle`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertJson(item, file, `${at}[${index}]`, seen);
    }
  } else if (Object.prototype.toString.call(value) === PLAIN_OBJECT) {
    for (const [key, item] of Object.entries(value)) {
      assertJson(item, file, `${at}.${key}`, seen);
    }
  } else {
    throw new TypeError(
      `@upwind/adapter: ${file}: ${at || '.'} is ${Object.prototype.toString.call(value)}, not JSON`,
    );
  }
  seen.delete(value);
}

/**
 * The JSON files directly under a directory: the build manifests Next.js reads at request time.
 * Excluded rather than listed, because a manifest Next.js reads without a fallback
 * (`routes-manifest`, `prerender-manifest`, `build-manifest`, `required-server-files`…) that a
 * list left out would fail every route, whereas a file it never reads costs only its bytes;
 * the traces (`*.nft.json`) are the one kind known to be of no use to it.
 */
async function jsonFilesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.nft.json'),
    )
    .map((entry) => path.join(dir, entry.name));
}

/**
 * The module's name inside the Worker: the file's path from the project root, with `/` between
 * segments whatever the build machine's own separator is — the runtime mounts the bundle under
 * POSIX paths, and Next.js reads its manifests by those.
 */
function moduleName(projectDir: string, file: string): string {
  return path.relative(projectDir, file).split(path.sep).join('/');
}

/** A route's own manifests: what its module reads next to itself. */
async function routeManifestModule(
  projectDir: string,
  file: string,
  deploymentId: string,
): Promise<TextModule | undefined> {
  if (file.endsWith('react-loadable-manifest.json')) {
    return { name: moduleName(projectDir, file), contents: await readFile(file, 'utf8') };
  }
  if (file.endsWith('_client-reference-manifest.js')) {
    const source = await readFile(file, 'utf8');
    return {
      name: moduleName(projectDir, file).replace(/\.js$/u, '.json'),
      contents: evaluateManifestScript(source, deploymentId, file),
    };
  }
  return undefined;
}

/**
 * Everything under `distDir` a route module may `readFileSync`. `deploymentId` is what the
 * Worker's `process.env.NEXT_DEPLOYMENT_ID` will be: the manifests are evaluated with it.
 */
export async function collectManifests(
  projectDir: string,
  distDir: string,
  deploymentId: string,
): Promise<TextModule[]> {
  const files: string[] = [];
  const buildId = path.join(distDir, 'BUILD_ID');
  if (await exists(buildId)) {
    files.push(buildId);
  }
  files.push(...(await jsonFilesIn(distDir)), ...(await jsonFilesIn(path.join(distDir, 'server'))));
  const modules: TextModule[] = [];
  for (const file of files) {
    modules.push({ name: moduleName(projectDir, file), contents: await readFile(file, 'utf8') });
  }
  const routeDirs = [path.join(distDir, 'server', 'app'), path.join(distDir, 'server', 'pages')];
  for (const routeDir of routeDirs) {
    if (!(await exists(routeDir))) {
      continue;
    }
    const routeFiles = await walk(routeDir);
    for (const file of routeFiles) {
      const module = await routeManifestModule(projectDir, file, deploymentId);
      if (module !== undefined) {
        modules.push(module);
      }
    }
  }
  return modules;
}
