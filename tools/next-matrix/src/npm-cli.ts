import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Find npm's JavaScript entry while retaining the caller's Node.js runtime. */
export async function npmCli(): Promise<string> {
  const npmEntry = 'npm-cli.js';
  const lookupTimeoutMs = 5000;
  const directories = [
    path.dirname(process.execPath),
    ...(process.env['PATH'] ?? '')
      .split(path.delimiter)
      .filter((directory) => directory.length > 0),
  ];
  const candidates = directories.flatMap((directory) => {
    return [
      path.join(directory, 'node_modules', 'npm', 'bin', npmEntry),
      path.join(directory, '..', 'lib', 'node_modules', 'npm', 'bin', npmEntry),
    ];
  });
  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  // Distribution packages can place npm elsewhere and symlink its CLI onto PATH.
  for (const directory of directories) {
    try {
      const candidate = await realpath(path.join(directory, 'npm'));
      if (path.basename(candidate) === npmEntry) return candidate;
    } catch {
      continue;
    }
  }
  // Native and shell shims are not symlinks. Ask their manager for the actual npm entry.
  for (const manager of ['volta', 'asdf', 'mise']) {
    try {
      const { stdout } = await execFileAsync(manager, ['which', 'npm'], {
        timeout: lookupTimeoutMs,
      });
      const executable = await realpath(stdout.trim());
      if (path.basename(executable) === npmEntry) return executable;
      const candidate = path.join(path.dirname(executable), npmEntry);
      await stat(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(
    `npm was not found beside ${process.execPath} or on PATH; looked in ${candidates.join(' and ')}`,
  );
}
