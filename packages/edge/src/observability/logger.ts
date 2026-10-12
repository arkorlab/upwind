/** Structured JSON logs; never include headers, cookies or bodies. */
export type LogFields = Record<string, string | number | boolean | undefined>;

export function logWarn(message: string, fields: LogFields = {}): void {
  console.warn(JSON.stringify({ level: 'warn', message, ...fields }));
}
