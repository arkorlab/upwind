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
    super(undefined, options);
    this.name = 'SchemaError';
    Object.defineProperty(this, 'issues', { value: issues, enumerable: false });
    // Written out when first read, as zod's is: an issue whose data cannot be JSON (a cycle a
    // refinement put in it) still leaves an error that can be caught and its issues read.
    let message: string | undefined;
    Object.defineProperty(this, 'message', {
      configurable: true,
      get: (): string => {
        message ??= JSON.stringify(issues, bigintAsDigits, 2);
        return message;
      },
      set: (value: string): void => {
        message = value;
      },
    });
  }
}
