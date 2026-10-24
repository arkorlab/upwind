import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ADAPTER_PACKAGE } from '../dev/adapter.ts';
import { resolveFromProject } from '../dev/next-app.ts';
import { moduleVersion, ownVersion } from '../manifest.ts';
import { projectNameFromPackage, PROJECT_NAME } from './names.ts';

/**
 * What a deploy was configured with: the project's `deploy` section, as the project's own adapter
 * reads it, with every default filled in.
 *
 * Read through the adapter the project builds with, never a copy of this command's own: the file
 * is the same one the build reads crons and splits from, and two readers of it would be two ways
 * for it to be read. Which is also why the adapter has to be this command's own version — an
 * adapter older or newer than the deploy that reads its configuration is one whose `deploy` this
 * command cannot vouch for.
 */

export type StorageKind = 'd1' | 'kv' | 'r2';

export interface StorageBinding {
  /** The binding's name, as the application reads it. */
  readonly name: string;
  readonly kind: StorageKind;
}

export interface DeploySettings {
  /** The configuration file the settings came from, relative to the project; for messages. */
  readonly file: string | undefined;
  readonly project: string;
  readonly workersDev: boolean;
  readonly hostnames: readonly string[];
  readonly keep: number;
  readonly storage: readonly StorageBinding[];
  readonly secrets: readonly string[];
  readonly images: boolean;
  readonly checks: readonly string[];
  readonly cspNonce:
    | { readonly mode: 'enforce' | 'report-only'; readonly strictDynamic: boolean }
    | undefined;
  readonly logs: boolean;
}

/** What `deploy.keep` is when the configuration does not say. */
export const DEFAULT_KEEP = 5;

export interface AdapterConfig {
  readonly file: string | undefined;
  readonly deploy?:
    | {
        readonly name?: string | undefined;
        readonly workersDev?: boolean | undefined;
        readonly hostnames?: readonly string[] | undefined;
        readonly keep?: number | undefined;
        readonly storage?: Readonly<Record<string, StorageKind>> | undefined;
        readonly secrets?: readonly string[] | undefined;
        readonly images?: boolean | undefined;
        readonly checks?: readonly string[] | undefined;
        readonly cspNonce?:
          | {
              readonly mode?: 'enforce' | 'report-only' | undefined;
              readonly strictDynamic?: boolean | undefined;
            }
          | undefined;
        readonly logs?: boolean | undefined;
      }
    | undefined;
}

type ReadProjectConfig = (projectDir: string) => Promise<AdapterConfig>;

/** The project's adapter's reader of its configuration, refused if it is not this command's version. */
export async function adapterReader(projectDir: string): Promise<ReadProjectConfig> {
  const adapter = resolveFromProject(projectDir, ADAPTER_PACKAGE);
  if (adapter === undefined) {
    throw new Error(
      `${ADAPTER_PACKAGE} is not installed in ${projectDir}, and a deployment is built with it — install it`,
    );
  }
  const [adapterVersion, version] = await Promise.all([moduleVersion(adapter), ownVersion()]);
  if (adapterVersion === undefined || adapterVersion !== version) {
    throw new Error(
      `${ADAPTER_PACKAGE} ${adapterVersion ?? '(unknown version)'} is installed in ${projectDir}, and this is upwind ${version ?? '(unknown version)'} — install the same version of both`,
    );
  }
  const module = (await import(pathToFileURL(adapter).href)) as {
    readProjectConfig?: ReadProjectConfig;
  };
  if (module.readProjectConfig === undefined) {
    throw new Error(
      `the ${ADAPTER_PACKAGE} installed in ${projectDir} cannot read a deploy configuration; install matching upwind packages`,
    );
  }
  return module.readProjectConfig;
}

/** The project's own name, from its `package.json`. */
async function packageName(projectDir: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(projectDir, 'package.json'), 'utf8'),
    );
    if (typeof parsed === 'object' && parsed !== null && 'name' in parsed) {
      return typeof parsed.name === 'string' ? parsed.name : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the project's settings. Runs the project's `upwind.config.ts`, when it has one: called after
 * the credentials were taken out of the environment (`credentials.ts`), never before.
 */
export async function readDeploySettings(
  projectDir: string,
  overrides: { readonly keep?: number | undefined } = {},
): Promise<DeploySettings> {
  const read = await adapterReader(projectDir);
  const config = await read(projectDir);
  const deploy = config.deploy ?? {};
  const project = deploy.name ?? projectNameFromPackage(await packageName(projectDir));
  if (project === undefined || !PROJECT_NAME.test(project)) {
    throw new Error(
      `the project's package name cannot be a name on a Cloudflare account; set \`deploy.name\` in ${config.file ?? 'upwind.config.ts'} — 2 to 24 lowercase letters, digits and single hyphens, from a letter`,
    );
  }
  const keep = overrides.keep ?? deploy.keep ?? DEFAULT_KEEP;
  return {
    file: config.file,
    project,
    workersDev: deploy.workersDev ?? true,
    hostnames: deploy.hostnames ?? [],
    keep,
    storage: Object.entries(deploy.storage ?? {}).map(([name, kind]) => ({ name, kind })),
    secrets: deploy.secrets ?? [],
    images: deploy.images ?? false,
    checks: deploy.checks ?? ['/'],
    cspNonce:
      deploy.cspNonce === undefined
        ? undefined
        : {
            mode: deploy.cspNonce.mode ?? 'enforce',
            strictDynamic: deploy.cspNonce.strictDynamic ?? false,
          },
    logs: deploy.logs ?? false,
  };
}
