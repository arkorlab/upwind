import { createReadGateway, createReadWorker } from '../read-gateway.ts';
import { STANDALONE_AUTHORITY } from './host.ts';

/**
 * The read gateway as a Worker of its own (`ARKOR_CACHE_READ`): what a deployment's Functions read
 * of their scope, answered from storage without the authority, under the standalone cache's label.
 */
// eslint-disable-next-line unicorn/no-top-level-side-effects -- A Worker's entry is loaded for its default export, which is the call that builds it.
export default createReadWorker(createReadGateway(STANDALONE_AUTHORITY));
