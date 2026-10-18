// eslint-disable-next-line no-restricted-imports, import-x/no-nodejs-modules -- Function-only: its runtime already requires native Node hashes for bounded key state.
import { createHash } from 'node:crypto';

import {
  canonicalEntryMaterial,
  type EntryDescriptor,
  ENTRY_ID_PREFIX,
  KEY_SCHEMA_VERSION,
} from '@stayingupwind/core/cache';
import { formatId, ID_PAYLOAD_BITS } from '@stayingupwind/core/util';

const BINARY_RADIX = 2n;
const ID_MODULUS = BINARY_RADIX ** BigInt(ID_PAYLOAD_BITS);

function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The entry a gateway's answer must belong to, as core's `deriveEntry` names it. The Function's
 * runtime already uses native Node hashes; these synchronous ones add no asynchronous stage to a
 * data read or lease. Core supplies the canonical material and id encoding: only the two hashes
 * and the derived-id seed are repeated here, held to core by the parity tests.
 */
export function requestedEntryId(scopeId: string, descriptor: EntryDescriptor): string {
  const digest = digestOf(canonicalEntryMaterial(descriptor));
  const seed = `${scopeId}|k${KEY_SCHEMA_VERSION}|${descriptor.kind}|${digest}`;
  return formatId(ENTRY_ID_PREFIX, BigInt(`0x${digestOf(seed)}`) % ID_MODULUS);
}
