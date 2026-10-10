import type { Issue } from './raw-issue.ts';

/** `JSON.stringify` of issues, with a bigint written as its digits, as zod writes them. */
function bigintAsDigits(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * What `parse` throws and a failed `safeParse` carries: the issues, and a message that is their
 * JSON — the same text zod's error carries, so a message read for a path still finds it.
 */
export class SchemaError extends Error {
  declare readonly issues: readonly Issue[];

  constructor(issues: readonly Issue[], options?: ErrorOptions) {
    super(JSON.stringify(issues, bigintAsDigits, 2), options);
    this.name = 'SchemaError';
    Object.defineProperty(this, 'issues', { value: issues, enumerable: false });
  }
}
