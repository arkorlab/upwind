/**
 * The four questions this tool asks of an answer it did not type the schema of.
 *
 * The API's own contract lives with the API, and restating it here would be a second copy to keep in
 * step — so each field is read where it is used, and a field that is not what it has to be says so
 * with the name of the thing that was wrong rather than at the first use of `undefined` three calls
 * later.
 */

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('the API answered something other than an object');
  }
  return value as Record<string, unknown>;
}

export function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value === undefined || value === null ? undefined : asRecord(value);
}

export function asString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('the API answered no string where one was required');
  }
  return value;
}

/**
 * Absent means absent: `null` or nothing at all.
 *
 * A present field of another type is not the same thing and is not read as one — a `value` that came
 * back as a number would otherwise be put back as `null`, which the API reads as "keep what is
 * stored", and the environment of the fixture before this one would answer for this one.
 */
export function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return asString(value);
}

export function asBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError('the API answered no boolean where one was required');
  }
  return value;
}

export function asStrings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError('the API answered no list of strings where one was required');
  }
  return value as string[];
}
