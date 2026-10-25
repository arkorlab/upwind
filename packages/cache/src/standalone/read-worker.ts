import { createReadGateway, createReadWorker } from '../read-gateway.ts';
import { STANDALONE_AUTHORITY } from './host.ts';

/**
 * The read gateway as a Worker of its own (`ARKOR_CACHE_READ`): what a deployment's Functions read
 * of their scope, answered from storage without the authority, under the standalone cache's label.
 */
export default createReadWorker(createReadGateway(STANDALONE_AUTHORITY));
