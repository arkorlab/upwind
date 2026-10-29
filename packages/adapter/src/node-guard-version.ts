import { isGuardedNodeVersion, type GuardedNodeVersion } from '@stayingupwind/core/util';

import { AuditError } from './dependencies.ts';

export type { GuardedNodeVersion };

/** The native artifact executes under the same exact Node loader as its producer. */
export function nodeGuardVersion(): GuardedNodeVersion {
  const version = process.versions.node;
  if (!isGuardedNodeVersion(version))
    throw new AuditError('Fixed Next initialization requires Node 24.22.1 or 26.13.0');
  return version;
}
