import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { PERSIST_DIR } from '../resources/local.ts';

/**
 * A signing key for a project that has not chosen one, kept where the rest of this machine's copy
 * of the project is kept.
 *
 * Authentication cannot start without a secret, and a project being set up has not got one. The
 * usual answer to that is a random value per process, which signs a session that the next restart
 * cannot read — so the developer is signed out by every save that restarts the server, which is most
 * of them. Persisting it is what makes the zero-config case usable rather than merely possible.
 *
 * Under `.upwind/`, which is already this machine's own: gitignored, rebuilt by deleting it, and
 * never a deployment's. A deployment sets `AUTH_SECRET` and none of this is read.
 *
 * Written here, in the CLI, rather than by `@stayingupwind/auth` — which runs inside the
 * application, in a development server today and in a Function tomorrow. A library that read a
 * project directory would carry `node:fs` and a path into a Function's bundle to do something a
 * Function can never do. So the file is the CLI's, and what the library sees is an environment
 * variable (`UPWIND_AUTH_SECRET_ENV`).
 */

/** Where it lives under `.upwind/`, beside the `d1/`, `kv/` and `r2/` the local runtime keeps. */
const SECRET_FILE = path.join('auth', 'secret');

/**
 * How much randomness the key carries. 32 bytes is the length of a SHA-256 digest and of the keys
 * Better Auth's own `generateRandomString` advice produces; base64url is the form because it
 * survives an environment variable, a `.env` line and a copy-paste without being escaped.
 */
const SECRET_BYTES = 32;

/** Owner-only. The file is a credential, even a development one, and a mode is cheap to be right. */
const SECRET_MODE = 0o600;

/**
 * A stored secret, or nothing when there is none to read yet.
 *
 * Trimmed, because a developer who opened the file to look at it may well have left a newline in
 * it, and a secret that changes when somebody looks at it is worse than one that is not there.
 */
async function stored(file: string): Promise<string | undefined> {
  try {
    const read = (await readFile(file, 'utf8')).trim();
    return read === '' ? undefined : read;
  } catch {
    return undefined;
  }
}

/**
 * The secret for this project's development runs, made if this is the first of them.
 *
 * `undefined` where the file can be neither read nor written — a read-only checkout, a full disk.
 * The caller carries on: a run without a persisted secret is a run where sessions do not survive a
 * restart, which is worth a warning and not worth a dev server.
 *
 * The write is exclusive, and that is what stands in for a lock. Two runs starting together — a dev
 * server and a build, which is an ordinary thing to do — would otherwise both find no file, both
 * generate, and the second would overwrite the first's key and sign the first's sessions out from
 * under it. `wx` means only one of them creates anything; the other is told the file exists and
 * reads what the winner wrote, and both end up with the same key.
 */
export async function projectAuthSecret(projectDir: string): Promise<string | undefined> {
  const file = path.join(projectDir, PERSIST_DIR, SECRET_FILE);
  const existing = await stored(file);
  if (existing !== undefined) {
    return existing;
  }
  const made = randomBytes(SECRET_BYTES).toString('base64url');
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${made}\n`, { mode: SECRET_MODE, flag: 'wx' });
    return made;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      // Somebody got there in the interval. Theirs is the key this project has.
      return stored(file);
    }
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `upwind: could not keep a development auth secret in ${file}, so sessions will not survive a restart (${reason})`,
    );
    return undefined;
  }
}
