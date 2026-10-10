import { localeMessage } from './messages.ts';
import type { Issue, RawIssue } from './raw-issue.ts';

/** A check's own message, kept beside the issue it raised rather than on it, so reporting never copies it. */
const CHECK_MESSAGES = new WeakMap<RawIssue, string>();

/** What reporting leaves out of an issue: what only parsing needed. */
const UNREPORTED: ReadonlySet<string> = new Set([
  '__proto__',
  'continue',
  'input',
  'inst',
  'schema',
]);

/**
 * Whether a failure stops what follows: an issue stops checks after it unless it says it may
 * continue, which only a check's or a refinement's own issues do.
 */
export function aborted(issues: readonly RawIssue[], start = 0): boolean {
  for (let index = start; index < issues.length; index++) {
    if (issues[index]?.continue !== true) {
      return true;
    }
  }
  return false;
}

/** Whether a failure stops even the checks that run regardless: one that said so outright. */
export function explicitlyAborted(issues: readonly RawIssue[], start = 0): boolean {
  for (let index = start; index < issues.length; index++) {
    if (issues[index]?.continue === false) {
      return true;
    }
  }
  return false;
}

/** The issues of a child, moved under the key or index it was read from. */
export function prefixIssues(segment: PropertyKey, issues: RawIssue[]): RawIssue[] {
  for (const issue of issues) {
    issue.path ??= [];
    issue.path.unshift(segment);
  }
  return issues;
}

/**
 * An issue as it is reported: its own keys in the order they were set, without what only parsing
 * needed (`input`, `continue`, and anything named `inst`, `schema` or `__proto__`), then a `path`
 * and a `message` where it had none.
 */
export function finalizeIssue(raw: RawIssue): Issue {
  // An issue's own message wins only when it reads as true, as zod decides it.
  const ownMessage = Boolean(raw.message);
  const message = ownMessage ? raw.message : (CHECK_MESSAGES.get(raw) ?? localeMessage(raw));
  const reported: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!UNREPORTED.has(key)) {
      reported[key] = value;
    }
  }
  reported['path'] ??= [];
  reported['message'] = message;
  return reported as unknown as Issue;
}

/** A raw issue that reports `message` unless it says otherwise. */
export function withMessage<T extends RawIssue>(issue: T, message: string | undefined): T {
  if (message !== undefined) {
    CHECK_MESSAGES.set(issue, message);
  }
  return issue;
}
