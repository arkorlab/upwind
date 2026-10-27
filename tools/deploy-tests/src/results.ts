/**
 * What a run keeps of a shard's suites for a compatibility record, and nothing more: which suites the
 * shard was to run, and for each suite that ran, every case's name and status. A case's messages are
 * left out — they quote the application's URLs, its output and whatever else the suite printed — but
 * a case that failed only because Jest's `test.failing` saw its body complete says so (`failure`):
 * that is how a case upstream expects to fail on its own provider reads where the body did what it
 * asked of a deployment here.
 */

/** Jest's own words for a `test.failing` case whose body completed. */
const FAILING_TEST_PASSED = 'Failing test passed even though it was supposed to fail';

/** One case of a suite, as kept. */
export interface KeptCase {
  readonly ancestorTitles: readonly string[];
  readonly title: string;
  readonly fullName: string;
  /** Jest's status for the case, as it wrote it: `passed`, `failed`, `pending` and the rest. */
  readonly status: string;
  /**
   * For a failed case only: `failing-test-passed` where Jest's refusal of a `test.failing` case whose
   * body completed is all it failed with, `other` for anything else.
   */
  readonly failure?: 'failing-test-passed' | 'other';
}

/** One suite's result, as kept. */
export interface KeptSuite {
  readonly path: string;
  /** Jest's status for the file: `passed` or `failed`. */
  readonly status: string;
  /** Whether Jest said the run was interrupted, or that the file could not run at all. */
  readonly interrupted: boolean;
  readonly runtimeError: boolean;
  readonly cases: readonly KeptCase[];
}

/** The suites a `run-tests.js --print-tests` listing names, one a line, in its order. */
export function listedSuites(listing: string): string[] {
  return listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^test\/\S+\.test\.[jt]sx?$/u.test(line));
}

function recordOf(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function stringOf(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${what} is not a string`);
  }
  return value;
}

function stringsOf(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`${what} is not a list of strings`);
  }
  return value as string[];
}

function arrayOf(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${what} is not a list`);
  }
  return value;
}

/** A failed case's failure, as kept: Jest's `test.failing` refusal alone, or anything else. */
function failureOf(messages: readonly string[]): 'failing-test-passed' | 'other' {
  return messages.length === 1 && messages[0]?.includes(FAILING_TEST_PASSED) === true
    ? 'failing-test-passed'
    : 'other';
}

function keptCase(value: unknown): KeptCase {
  const entry = recordOf(value, 'a case');
  const status = stringOf(entry['status'], "a case's status");
  const kept = {
    ancestorTitles: stringsOf(entry['ancestorTitles'], "a case's ancestor titles"),
    title: stringOf(entry['title'], "a case's title"),
    fullName: stringOf(entry['fullName'], "a case's full name"),
    status,
  };
  if (status !== 'failed') {
    return kept;
  }
  const messages = stringsOf(entry['failureMessages'] ?? [], "a case's failure messages");
  return { ...kept, failure: failureOf(messages) };
}

/**
 * One suite's result as the run wrote it (`<suite>.results.json`, Jest's own JSON), kept as above.
 * The file's entry is the one Jest wrote for this suite, by its path.
 */
export function keptSuite(path: string, raw: unknown): KeptSuite {
  const file = recordOf(raw, `the result of ${path}`);
  const entries = arrayOf(file['testResults'], `the test results of ${path}`).map((entry) =>
    recordOf(entry, `a test result of ${path}`),
  );
  const own = entries.find((entry) => {
    const name = stringOf(entry['name'], `the name of a test result of ${path}`);
    return name === path || name.endsWith(`/${path}`);
  });
  if (own === undefined) {
    throw new TypeError(`the result of ${path} holds no entry for it`);
  }
  return {
    path,
    status: stringOf(own['status'], `the status of ${path}`),
    interrupted: file['wasInterrupted'] === true,
    runtimeError:
      typeof file['numRuntimeErrorTestSuites'] === 'number' &&
      file['numRuntimeErrorTestSuites'] > 0,
    cases: arrayOf(own['assertionResults'], `the cases of ${path}`).map((entry) => keptCase(entry)),
  };
}
