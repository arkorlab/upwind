import type { IncomingHttpHeaders } from 'node:http';

import { acceptsCspNonce } from '@stayingupwind/core/request';

import { answeredBy, EDGE_HEADER, HTTP_OK, noncedPoliciesOf } from './answers.ts';
import type { Reading } from './reading.ts';
import type { CspNonceSetting, LocalStack } from './stack.ts';
import { BACKSTAGE_ROUTES, NONCE_PARAMS, type StampedDigest } from './workers/protocol.ts';

/**
 * A document's nonce, as a site that opted in has the edge mint one for each document it composes
 * (`StackOptions.cspNonce`; `documentHeaders` in the edge): minted where the policies the
 * application laid on the document have somewhere for one to go, put in them as the setting says,
 * and stamped on the document's scripts — the build's shell among them (`documents.ts`). What the
 * edge makes of a nonce is asked of its own code, on the stack's backstage.
 */

/** The policies a nonce goes in (`CSP_HEADERS` in the edge). */
const POLICY_HEADERS: readonly string[] = [
  'content-security-policy',
  'content-security-policy-report-only',
];
/** What the edge's account of a document says of a nonce it minted, and of the setting. */
const MINTED = 'csp=nonce';
const REPORT_ONLY = 'csp-mode=report-only';
const STRICT_DYNAMIC = 'csp-strict-dynamic';
/** A nonce source in a policy, and its value. */
const NONCE_SOURCE = /'nonce-([^'\s]+)'/u;

/** What the edge did of a nonce on a document, as the check judges it. */
export type Nonced =
  /** It minted none, as the setting has it mint none for the document. */
  | { readonly kind: 'none' }
  /** It minted `nonce`: the policies the application laid, with the nonce put in them. */
  | { readonly kind: 'minted'; readonly nonce: string; readonly laid: Headers }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * Why what the edge says of the site's setting on a document it composed is not the stack's: every
 * document of a site that opted in says where the nonce goes, where that is a report-only policy,
 * and whether `'strict-dynamic'` goes beside it — and none of another site's does.
 */
function settingFailure(
  account: readonly string[],
  setting: CspNonceSetting | undefined,
): string | undefined {
  const reportOnly = setting?.mode === 'report-only';
  if (account.includes(REPORT_ONLY) !== reportOnly) {
    return reportOnly
      ? `does not say the site's nonce goes in a report-only policy (${REPORT_ONLY})`
      : `says a nonce goes in a report-only policy (${REPORT_ONLY}), which the site did not ask for`;
  }
  const strict = setting?.strictDynamic === true;
  if (account.includes(STRICT_DYNAMIC) !== strict) {
    return strict
      ? `does not say 'strict-dynamic' goes beside the site's nonce (${STRICT_DYNAMIC})`
      : `says 'strict-dynamic' goes beside a nonce (${STRICT_DYNAMIC}), which the site did not ask for`;
  }
  return undefined;
}

/** Whether policies as laid have somewhere for a nonce to go (`acceptsNonce` in the edge). */
function takesNonce(laid: Headers): boolean {
  return POLICY_HEADERS.some((name) => {
    const policy = laid.get(name);
    return policy !== null && acceptsCspNonce(policy);
  });
}

/** The nonce a document's policies name: the one the edge minted for it, where it minted one. */
function nonceIn(headers: IncomingHttpHeaders): string | undefined {
  for (const name of POLICY_HEADERS) {
    const sent = headers[name];
    const policy = Array.isArray(sent) ? sent.join(', ') : sent;
    const named = policy === undefined ? undefined : NONCE_SOURCE.exec(policy)?.[1];
    if (named !== undefined) {
      return named;
    }
  }
  return undefined;
}

/**
 * What the edge did of a nonce on a document it composed, which the application laid `laid` on:
 * none, where the stack's setting has it mint none — a site that did not opt in, or policies with
 * nowhere for one — or the one it minted, which the document's policies name, and the policies as
 * they go out with it in them. A failure where the edge did otherwise, or said otherwise of the
 * setting.
 */
export async function noncedOf(stack: LocalStack, answer: Reading, laid: Headers): Promise<Nonced> {
  const account = answeredBy(answer).split(';');
  const setting = stack.cspNonce;
  const said = settingFailure(account, setting);
  if (said !== undefined) {
    return { kind: 'failed', reason: said };
  }
  const takes = setting !== undefined && takesNonce(laid);
  if (account.includes(MINTED) !== takes) {
    const reason = takes
      ? 'stamped no nonce, though the site asks for one and its policies have somewhere for it'
      : 'stamped a nonce, though the site asks for none or its policies have nowhere for it';
    return { kind: 'failed', reason };
  }
  if (setting === undefined || !takes) {
    return { kind: 'none' };
  }
  const nonce = nonceIn(answer.headers);
  if (nonce === undefined) {
    return { kind: 'failed', reason: 'says it stamped a nonce, which none of its policies names' };
  }
  const policies: Record<string, string> = {};
  for (const name of POLICY_HEADERS) {
    const policy = laid.get(name);
    if (policy !== null) {
      policies[name] = policy;
    }
  }
  const put = await noncedPoliciesOf(stack, policies, { nonce, setting });
  const nonced = new Headers(laid);
  for (const name of POLICY_HEADERS) {
    nonced.delete(name);
  }
  for (const [name, policy] of Object.entries(put)) {
    nonced.set(name, policy);
  }
  return { kind: 'minted', nonce, laid: nonced };
}

/**
 * Where a copy of a document goes as it streams (`ReadOptions.copyTo`), to be stamped again with the
 * nonce the edge says it minted for it, by the edge's own code (`BACKSTAGE_ROUTES.stampedDigest`):
 * a document the edge stamped throughout — its shell and what followed it — is the same bytes
 * stamped again. None for one it says it minted no nonce for, or that is coded and read as it came
 * (`codingFailure` judges that); one read undone of its coding (`decoded`) is copied undone, and
 * stamped again as such.
 */
export function restampAt(
  stack: LocalStack,
  headers: IncomingHttpHeaders,
  decoded = false,
): URL | undefined {
  const account = String(headers[EDGE_HEADER] ?? '').split(';');
  const uncoded = decoded || headers['content-encoding'] === undefined;
  const nonce = uncoded && account.includes(MINTED) ? nonceIn(headers) : undefined;
  if (nonce === undefined) {
    return undefined;
  }
  const asked = new URLSearchParams({ [NONCE_PARAMS.nonce]: nonce });
  return new URL(`.${BACKSTAGE_ROUTES.stampedDigest}?${asked}`, stack.backstage);
}

/** The digest the backstage answered a document stamped again with, if it answered one. */
function stampedDigestIn(text: string): StampedDigest | undefined {
  let answered: unknown;
  try {
    answered = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof answered !== 'object' || answered === null) {
    return undefined;
  }
  const { sha256, length } = answered as Record<string, unknown>;
  return typeof sha256 === 'string' && typeof length === 'number' ? { sha256, length } : undefined;
}

/**
 * Why a document the edge minted a nonce for does not name it throughout, as the edge stamps it
 * (`rewriteDocumentNonces`) — on every script, every preload of one and every element that names
 * a nonce, in its shell and in what followed it: stamped again with it, it is other bytes. Judged
 * where a copy of it was stamped again as it streamed (`restampAt`).
 */
export function unstampedFailure(answer: Reading): string | undefined {
  const { copied } = answer;
  if (copied === undefined) {
    return undefined;
  }
  if (copied.kind === 'failed') {
    throw new Error(
      `the stack's backstage was not sent a document to stamp again: ${copied.reason}`,
    );
  }
  if (copied.status !== HTTP_OK) {
    throw new Error(
      `the stack's backstage answered ${copied.status} for a document to stamp again`,
    );
  }
  const restamped = stampedDigestIn(copied.text);
  if (restamped === undefined) {
    throw new Error("the stack's backstage answered a document to stamp again without its digest");
  }
  return restamped.sha256 === answer.sha256 && restamped.length === answer.length
    ? undefined
    : 'does not name the nonce the edge minted for it on every script, every preload of one and every element that names a nonce, past its shell as in it';
}
