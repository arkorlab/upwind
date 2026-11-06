import { logContextEnvelope } from '@stayingupwind/core/paas';

/** The identifiers to associate with the current server invocation's runtime logs. */
export type LogContext = Readonly<Record<string, string>>;

/**
 * Record one complete identifier map for this invocation. Call once, after authentication has
 * resolved the IDs. This synchronous call makes no network request and keeps no ambient state.
 *
 * Returns false for invalid or oversized context, or when console logging throws. A true result
 * means the record was emitted; storage and delivery still follow the host's logging settings.
 */
export function setLogContext(context: LogContext): boolean {
  const envelope = logContextEnvelope(context);
  if (envelope === undefined) return false;
  try {
    // eslint-disable-next-line no-console -- the host collects this bounded structured marker.
    console.log(envelope);
    return true;
  } catch {
    return false;
  }
}
