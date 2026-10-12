import type { AuthorityHost } from '../authority-host.ts';
import { STANDALONE_NAMING } from './naming.ts';

/**
 * What a standalone cache decides for its authority (`AuthorityHost`): the label its scopes' tokens
 * are signed over, no region asked for — the runtime places a scope's object where it is first
 * reached — and nothing metered.
 */
export const STANDALONE_AUTHORITY: AuthorityHost = {
  naming: STANDALONE_NAMING,
  meter: {
    read: (): void => {
      // No host reads a standalone cache's meter.
    },
    write: (): void => {
      // As for reads.
    },
  },
};
