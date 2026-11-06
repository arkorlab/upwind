import { setLogContext, type LogContext } from '@stayingupwind/sdk/logs';

/** The installed entry point exposes its own declarations without requiring runtime internals. */
export function publicLogContextTypes(context: LogContext): boolean {
  const identifiers: Readonly<Record<string, string>> = context;
  return setLogContext(identifiers);
}
