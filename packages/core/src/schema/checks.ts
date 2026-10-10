import { aborted, explicitlyAborted, withMessage } from './issues.ts';
import type { RawIssue } from './raw-issue.ts';

/** What a schema parses: the value as it stands, and every issue found so far. */
export interface Payload {
  value: unknown;
  issues: RawIssue[];
}

/** How a parse runs: `validate` stops at the first child that fails outright. */
export interface ParseContext {
  readonly abortEarly: boolean;
}

/** An issue as `superRefine`'s `ctx.addIssue` takes it. */
export interface RefinementIssue {
  [key: string]: unknown;
  code?: string;
  message?: string;
  path?: PropertyKey[];
  fatal?: boolean;
  input?: unknown;
  continue?: boolean;
}

/** What `superRefine` hands its callback beside the value. */
export interface RefinementContext<T = unknown> {
  readonly value: T;
  readonly issues: readonly RawIssue[];
  addIssue: (issue: RefinementIssue | string) => void;
}

/** A refinement as a schema holds it, its parameters erased. */
type Refinement = (value: unknown) => unknown;
type SuperRefinement = (value: unknown, ctx: RefinementContext) => unknown;

/**
 * One check a schema runs after its own type, in the order the chain wrote them. Plain data, so
 * that building a schema allocates no closure; what each one does is `runCheck`'s.
 */
export type Check =
  | {
      readonly kind: 'max_length' | 'min_length' | 'length_equals';
      readonly value: number;
      readonly message: string | undefined;
    }
  | {
      readonly kind: 'greater_than' | 'less_than';
      readonly value: number;
      readonly inclusive: boolean;
      readonly message: string | undefined;
    }
  | { readonly kind: 'safe_int'; readonly message: string | undefined }
  | { readonly kind: 'regex'; readonly pattern: RegExp; readonly message: string | undefined }
  | { readonly kind: 'starts_with'; readonly prefix: string; readonly message: string | undefined }
  | { readonly kind: 'trim' }
  | { readonly kind: 'datetime' }
  | { readonly kind: 'url' }
  | {
      readonly kind: 'refine';
      readonly fn: Refinement;
      readonly message: string | undefined;
      readonly path: readonly PropertyKey[] | undefined;
    }
  | { readonly kind: 'super_refine'; readonly fn: SuperRefinement };

/**
 * An ISO 8601 date and time in UTC, seconds required, any fraction: byte for byte the pattern zod
 * builds for `z.iso.datetime()`, since an issue reports it.
 */
const DATETIME =
  // eslint-disable-next-line regexp/no-useless-non-capturing-group, require-unicode-regexp, sonarjs/regex-complexity -- zod's own pattern, flags and all: an issue reports it as written.
  /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z))$/;
const TAB_OR_NEWLINE = /[\t\n\r]/gu;
const HIGH_SURROGATE = /[\uD800-\uDBFF]/u;
const SURROGATE_MASK = 0xfc_00;
const HIGH_SURROGATE_START = 0xd8_00;
const LOW_SURROGATE_START = 0xdc_00;

/** Code points: a surrogate pair counts once, a lone surrogate as itself. */
function codePointLength(text: string): number {
  if (!HIGH_SURROGATE.test(text)) {
    return text.length;
  }
  let count = text.length;
  for (let index = 0; index < text.length - 1; index++) {
    if (
      // eslint-disable-next-line no-bitwise, unicorn/prefer-code-point -- a UTF-16 unit's high bits say which half of a pair it is.
      (text.charCodeAt(index) & SURROGATE_MASK) === HIGH_SURROGATE_START &&
      // eslint-disable-next-line no-bitwise, unicorn/prefer-code-point -- a UTF-16 unit's high bits say which half of a pair it is.
      (text.charCodeAt(index + 1) & SURROGATE_MASK) === LOW_SURROGATE_START
    ) {
      count -= 1;
      index += 1;
    }
  }
  return count;
}

function lengthOrigin(input: unknown): string {
  if (Array.isArray(input)) {
    return 'array';
  }
  return typeof input === 'string' ? 'string' : 'unknown';
}

function hasLength(value: unknown): boolean {
  return (
    value !== undefined &&
    value !== null &&
    (value as { readonly length?: unknown }).length !== undefined
  );
}

function withinLength(
  kind: 'max_length' | 'min_length' | 'length_equals',
  counted: number,
  bound: number,
): boolean {
  if (kind === 'max_length') {
    return counted <= bound;
  }
  return kind === 'min_length' ? counted >= bound : counted === bound;
}

function checkLength(
  check: Extract<Check, { readonly kind: 'max_length' | 'min_length' | 'length_equals' }>,
  payload: Payload,
): void {
  const input = payload.value as { readonly length: number };
  const counted = typeof input === 'string' ? codePointLength(input) : input.length;
  if (withinLength(check.kind, counted, check.value)) {
    return;
  }
  const origin = lengthOrigin(input);
  const big =
    check.kind === 'max_length' || (check.kind === 'length_equals' && counted > check.value);
  const issue: RawIssue = big
    ? { origin, code: 'too_big', maximum: check.value, inclusive: true }
    : { origin, code: 'too_small', minimum: check.value, inclusive: true };
  if (check.kind === 'length_equals') {
    issue['exact'] = true;
  }
  issue.input = input;
  issue.continue = true;
  payload.issues.push(withMessage(issue, check.message));
}

function inBound(
  value: number,
  check: Extract<Check, { readonly kind: 'greater_than' | 'less_than' }>,
): boolean {
  if (check.kind === 'less_than') {
    return check.inclusive ? value <= check.value : value < check.value;
  }
  return check.inclusive ? value >= check.value : value > check.value;
}

function compare(
  check: Extract<Check, { readonly kind: 'greater_than' | 'less_than' }>,
  payload: Payload,
): void {
  const value = payload.value as number;
  const below = check.kind === 'less_than';
  if (inBound(value, check)) {
    return;
  }
  const issue: RawIssue = below
    ? { origin: 'number', code: 'too_big', maximum: check.value }
    : { origin: 'number', code: 'too_small', minimum: check.value };
  issue.input = value;
  issue['inclusive'] = check.inclusive;
  issue.continue = true;
  payload.issues.push(withMessage(issue, check.message));
}

const SAFE_INTEGER_NOTE = 'Integers must be within the safe integer range.';

function checkSafeInteger(
  check: Extract<Check, { readonly kind: 'safe_int' }>,
  payload: Payload,
): void {
  const input = payload.value as number;
  // eslint-disable-next-line unicorn/prefer-number-is-safe-integer -- an integer outside the safe range is a different issue, reported below.
  if (!Number.isInteger(input)) {
    payload.issues.push(
      withMessage(
        { expected: 'int', format: 'safeint', code: 'invalid_type', continue: false, input },
        check.message,
      ),
    );
    return;
  }
  if (Number.isSafeInteger(input)) {
    return;
  }
  const issue: RawIssue =
    input > 0
      ? { input, code: 'too_big', maximum: Number.MAX_SAFE_INTEGER, note: SAFE_INTEGER_NOTE }
      : { input, code: 'too_small', minimum: Number.MIN_SAFE_INTEGER, note: SAFE_INTEGER_NOTE };
  issue['origin'] = 'int';
  issue['inclusive'] = true;
  issue.continue = true;
  payload.issues.push(withMessage(issue, check.message));
}

function checkPattern(
  check: Extract<Check, { readonly kind: 'regex' | 'starts_with' | 'datetime' }>,
  payload: Payload,
): void {
  const text = payload.value as string;
  if (check.kind === 'starts_with') {
    if (text.startsWith(check.prefix)) {
      return;
    }
    payload.issues.push(
      withMessage(
        {
          origin: 'string',
          code: 'invalid_format',
          format: 'starts_with',
          prefix: check.prefix,
          input: text,
          continue: true,
        },
        check.message,
      ),
    );
    return;
  }
  const pattern = check.kind === 'regex' ? check.pattern : DATETIME;
  pattern.lastIndex = 0;
  if (pattern.test(text)) {
    return;
  }
  payload.issues.push(
    withMessage(
      {
        origin: 'string',
        code: 'invalid_format',
        format: check.kind,
        input: text,
        pattern: pattern.toString(),
        continue: true,
      },
      check.kind === 'regex' ? check.message : undefined,
    ),
  );
}

function canParseUrl(text: string): boolean {
  try {
    return URL.canParse(text);
  } catch {
    return false;
  }
}

/** A URL as zod reads one: trimmed, and parsed as the URL parser would; tabs and newlines dropped. */
function checkUrl(payload: Payload): void {
  const trimmed = (payload.value as string).trim();
  if (canParseUrl(trimmed)) {
    payload.value = trimmed.replaceAll(TAB_OR_NEWLINE, '');
    return;
  }
  payload.issues.push({
    code: 'invalid_format',
    format: 'url',
    input: payload.value,
    continue: true,
  });
}

function assertSynchronous(result: unknown): void {
  if (result instanceof Promise) {
    throw new TypeError('Encountered Promise during synchronous parse. Use .parseAsync() instead.');
  }
}

function refine(check: Extract<Check, { readonly kind: 'refine' }>, payload: Payload): void {
  const input = payload.value;
  const result = check.fn(input);
  assertSynchronous(result);
  // Whatever reads as false fails, as zod decides it: `NaN` and `0n` too.
  const passed = Boolean(result);
  if (!passed) {
    payload.issues.push(
      withMessage(
        { code: 'custom', input, path: [...(check.path ?? [])], continue: true },
        check.message,
      ),
    );
  }
}

/**
 * `ctx.addIssue` as zod has it. A string is an issue that stops the checks after it. An object is
 * completed where it says nothing — a `custom` code, the value, a `continue` unless `fatal` — and
 * pushed as a copy, keys in the order they now stand.
 */
function superRefine(
  check: Extract<Check, { readonly kind: 'super_refine' }>,
  payload: Payload,
): void {
  const ctx: RefinementContext = {
    value: payload.value,
    issues: payload.issues,
    addIssue(issue: RefinementIssue | string): void {
      if (typeof issue === 'string') {
        // No `continue`, as zod pushes it: the checks after it are skipped, except a length check,
        // which runs unless a failure said outright to stop, and this one does not.
        payload.issues.push({ message: issue, code: 'custom', input: payload.value });
        return;
      }
      if (issue.fatal === true) {
        issue.continue = false;
      }
      issue.code ??= 'custom';
      if (!('input' in issue)) {
        issue.input = payload.value;
      }
      issue.continue ??= true;
      const copy = { ...issue };
      // The path is the caller's array; one of our own is what parents prefix their keys onto.
      if (Array.isArray(copy.path)) {
        copy.path = [...copy.path];
      }
      payload.issues.push(copy);
    },
  };
  assertSynchronous(check.fn(payload.value, ctx));
}

function runCheck(check: Check, payload: Payload): void {
  switch (check.kind) {
    case 'max_length':
    case 'min_length':
    case 'length_equals': {
      checkLength(check, payload);
      break;
    }
    case 'greater_than':
    case 'less_than': {
      compare(check, payload);
      break;
    }
    case 'safe_int': {
      checkSafeInteger(check, payload);
      break;
    }
    case 'regex':
    case 'starts_with':
    case 'datetime': {
      checkPattern(check, payload);
      break;
    }
    case 'trim': {
      payload.value = (payload.value as string).trim();
      break;
    }
    case 'url': {
      checkUrl(payload);
      break;
    }
    case 'refine': {
      refine(check, payload);
      break;
    }
    case 'super_refine': {
      superRefine(check, payload);
      break;
    }
  }
}

/** Whether a check runs whatever the type said, as zod's length checks do: on anything with a length. */
const LENGTH_CHECKS: ReadonlySet<Check['kind']> = new Set([
  'length_equals',
  'max_length',
  'min_length',
]);

function runsRegardless(check: Check): boolean {
  return LENGTH_CHECKS.has(check.kind);
}

/**
 * A schema's checks, in order, after its type. A check is skipped once something before it failed
 * outright, except that a length check still runs on any value with a length unless a failure said
 * to stop everything.
 */
export function runChecks(payload: Payload, checks: readonly Check[]): Payload {
  let isAborted = aborted(payload.issues);
  for (const check of checks) {
    if (runsRegardless(check)) {
      if (explicitlyAborted(payload.issues) || !hasLength(payload.value)) {
        continue;
      }
    } else if (isAborted) {
      continue;
    }
    const before = payload.issues.length;
    runCheck(check, payload);
    if (!isAborted && payload.issues.length !== before) {
      isAborted = aborted(payload.issues, before);
    }
  }
  return payload;
}
