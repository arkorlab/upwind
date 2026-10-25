import { adapterReader } from '../deploy/config.ts';

/**
 * What a preview takes of the project's `deploy` section, read as a deploy reads it — through the
 * project's own adapter, which has to be this command's version — so that a preview serves the
 * build as the project would have it deployed: the same secrets, nonce, hostnames and checks.
 *
 * The name the project would have on an account is not read: a preview reaches none, and whether a
 * deploy would take the project is `upwind deploy --dry-run`'s to say.
 */

export interface PreviewSettings {
  /** The configuration file the settings came from, relative to the project; for messages. */
  readonly file: string | undefined;
  /** `deploy.secrets`: names read from the environment. */
  readonly secrets: readonly string[];
  readonly cspNonce:
    | { readonly mode: 'enforce' | 'report-only'; readonly strictDynamic: boolean }
    | undefined;
  /** The hostnames the edge is reached on deployed: a Function that asks one of the site is the site. */
  readonly hostnames: readonly string[];
  /** The paths a deploy asks before it switches to a deployment. */
  readonly checks: readonly string[];
  /**
   * What a deploy gives a project that a preview does not yet, for it to say so: the storage it
   * binds, by name, and images it transforms. The cron jobs it fires are the build's to say.
   */
  readonly storage: readonly string[];
  readonly images: boolean;
}

/** The paths a deploy asks where the configuration names none. */
const DEFAULT_CHECKS = ['/'];

/** Read the project's settings. Runs the project's `upwind.config.ts`, when it has one. */
export async function readPreviewSettings(projectDir: string): Promise<PreviewSettings> {
  const read = await adapterReader(projectDir);
  const config = await read(projectDir);
  const deploy = config.deploy ?? {};
  return {
    file: config.file,
    secrets: deploy.secrets ?? [],
    cspNonce:
      deploy.cspNonce === undefined
        ? undefined
        : {
            mode: deploy.cspNonce.mode ?? 'enforce',
            strictDynamic: deploy.cspNonce.strictDynamic ?? false,
          },
    hostnames: deploy.hostnames ?? [],
    checks: deploy.checks ?? DEFAULT_CHECKS,
    storage: Object.keys(deploy.storage ?? {}),
    images: deploy.images ?? false,
  };
}
