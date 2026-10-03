import {
  isBeforeSecurityFloor,
  SECURITY_FLOOR,
  SECURITY_RELEASE_URL,
} from '@stayingupwind/core/next';
import { UPWIND_INTERNAL_PREFIX } from '@stayingupwind/core/paas';

import { type DevSession, readyInMs } from './session.ts';

/**
 * What a run says about itself.
 *
 * `next dev` prints its own banner from the parent process this one replaces, so nothing would print
 * it here. Two lines rather than one, at the two moments a developer is waiting for: the address as
 * soon as it is bound — `/__upwind` answers from that moment, before a single module is compiled —
 * and how long Next.js took once it is ready.
 *
 * A warning follows the second of those when the version it names is one with known
 * vulnerabilities in it.
 */

export function printListening(session: DevSession): void {
  const version = session.upwindVersion === undefined ? '' : ` ${session.upwindVersion}`;
  console.log('');
  console.log(`  upwind${version} dev`);
  console.log(`  - Local:     ${session.address ?? ''}`);
  console.log(`  - Internal:  ${session.address ?? ''}${UPWIND_INTERNAL_PREFIX}`);
  console.log('');
}

export function printReady(session: DevSession): void {
  const elapsed = readyInMs(session);
  const took = elapsed === undefined ? '' : ` in ${elapsed}ms`;
  const next = session.nextVersion === undefined ? 'Next.js' : `Next.js ${session.nextVersion}`;
  console.log(`  ✓ ${next} ready${took}`);
  printSecurityNotice(session.nextVersion);
}

/**
 * The version this run is on, when it is older than the newest release that carried security fixes.
 *
 * `SECURITY_FLOOR` is `@stayingupwind/core/next`'s, which is what the adapter warns against once a
 * build is written as well: one claim about one Next.js release, declared once. What a development
 * run adds to it is what only a development run has — `next dev` serves the MCP endpoint a page the
 * developer visits can read a project out of, and it optimizes `/_next/image` itself, where a
 * deployment answers that path without Next.js in it. Both of those are this process.
 *
 * In this run's own words rather than the banner's, because it is a warning and not a line of the
 * banner: `upwind: …` on `console.warn`, as every other warning of this CLI is. Said rather than
 * refused — the run is the developer's, and a project held to an older Next.js for reasons of its
 * own still has to be runnable. A version that cannot be read is not judged at all.
 */
function printSecurityNotice(nextVersion: string | undefined): void {
  if (nextVersion === undefined || !isBeforeSecurityFloor(nextVersion)) {
    return;
  }
  console.warn(
    `upwind: Next.js ${nextVersion} is older than ${SECURITY_FLOOR}, the newest release with security fixes in it that upwind knows of, and a development run is the one that serves the MCP endpoint and optimizes images itself — ${SECURITY_RELEASE_URL}`,
  );
}
