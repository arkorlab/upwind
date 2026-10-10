import { REDIRECT_STATUSES } from '@stayingupwind/core/request';

const HTTP_OK = 200;
const HTTP_SERVER_ERROR = 500;

/**
 * Whether a visitor may be answered with what a render or a generation says, as it says it: never
 * a status a `Response` cannot carry — below 200 — nor a server error, which no generation is
 * published under, and never a redirect that does not say where it leads. That one would send the
 * visitor nowhere. A record can say either: one seeded by a deployment older than the Function
 * that reads it, or than the upload check that now holds a status to 200–599, does.
 */
export function servable(status: number, headers: Readonly<Record<string, string>>): boolean {
  if (status < HTTP_OK || status >= HTTP_SERVER_ERROR) {
    return false;
  }
  return !REDIRECT_STATUSES.has(status) || headers['location'] !== undefined;
}
