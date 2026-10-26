import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const COMMAND_MS = 600_000;
const MAX_COMMAND_OUTPUT = 1_048_576;
const MAX_ERROR_CODES = 8;

/** Do not forward compiler logs: fixed public source profiles are the only retained output. */
export async function command(
  file: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const child = spawn(file, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  const output: Buffer[] = [];
  const diagnostic: Buffer[] = [];
  let bytes = 0;
  let overflow = false;
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
  }, COMMAND_MS);
  function isWithinBudget(chunk: Buffer): boolean {
    bytes += chunk.length;
    if (bytes > MAX_COMMAND_OUTPUT) {
      overflow = true;
      child.kill('SIGKILL');
      return false;
    }
    return true;
  }
  child.stdout.on('data', (chunk: Buffer) => {
    if (isWithinBudget(chunk)) {
      output.push(chunk);
      diagnostic.push(chunk);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (isWithinBudget(chunk)) diagnostic.push(chunk);
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const codes = [
      ...new Set(
        Buffer.concat(diagnostic)
          .toString('utf8')
          .match(/\bERR_[A-Z\d_]{1,80}\b/gu),
      ),
    ].slice(0, MAX_ERROR_CODES);
    assert.ok(
      code === 0 && !overflow,
      `Independent public compiler command failed (exit=${String(code)}, overflow=${String(overflow)}, codes=${codes.join(',')})`,
    );
    return Buffer.concat(output).toString('utf8').trim();
  } finally {
    clearTimeout(timer);
  }
}
