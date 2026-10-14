/** Structured JSON logs; never include headers, cookies or bodies. */
export type LogFields = Record<string, string | number | boolean | undefined>;

export function logWarn(message: string, fields: LogFields = {}): void {
  const line = { level: 'warn', message, ...fields };
  // The line's own level and message stand, first as ever, whatever the fields name.
  console.warn(JSON.stringify({ ...line, level: 'warn', message }));
}
