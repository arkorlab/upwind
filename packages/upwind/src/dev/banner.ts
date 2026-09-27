import { UPWIND_INTERNAL_PREFIX } from '@stayingupwind/core/paas';

import { type DevSession, readyInMs } from './session.ts';

/**
 * What a run says about itself.
 *
 * `next dev` prints its own banner from the parent process this one replaces, so nothing would print
 * it here. Two lines rather than one, at the two moments a developer is waiting for: the address as
 * soon as it is bound — `/__upwind` answers from that moment, before a single module is compiled —
 * and how long Next.js took once it is ready.
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
}
