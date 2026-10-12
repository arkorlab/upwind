import * as z from '../schema/index.ts';
import { isId } from '../util/id.ts';

/**
 * A deployment's id, and the schema that checks one.
 *
 * Apart from the bundle's own schema (`schema.ts`) for the reason `carried.ts` is: so that a reader
 * of an id builds this and nothing else. A Function's cache host checks the deployment id in what
 * the cache answers, and the runtime it is bundled into is evaluated before the Function's first
 * response. Taken from `schema.ts`, the id brought every schema an upload is checked with into that
 * runtime — the bundle, its routes, prerenders and Functions, its crons, its images config, and the
 * pattern checks behind them — and built them all as it was evaluated: 20 KB of the minimal
 * fixture's runtime, none of which a request reads.
 */

export const DEPLOYMENT_ID_PREFIX = 'dpl';

export const deploymentIdSchema = z
  .string()
  .refine((value) => isId(DEPLOYMENT_ID_PREFIX, value), 'expected a deployment id');
