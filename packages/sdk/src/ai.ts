import { type AiInference, inference } from './ai-inference.ts';
import { AI } from './kinds.ts';
import { sole } from './sole.ts';

export type { AiInference } from './ai-inference.ts';
export { ai } from './named.ts';

/** Resolve the sole published AI capability only when run() is called. */
const capability: AiInference = inference(sole(AI));

export default capability;
