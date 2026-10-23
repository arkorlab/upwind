/** Structured JSON logging for the little this Worker reports: a read of the bucket that failed. */

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function logError(message: string, fields: LogFields = {}): void {
  console.error(JSON.stringify({ level: 'error', msg: message, component: 'blob', ...fields }));
}
