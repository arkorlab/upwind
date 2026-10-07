import { start } from 'workflow/api';

import { greet } from '../../../workflows/greet.js';

export async function POST() {
  const run = await start(greet, ['upwind']);
  return Response.json({ runId: run.runId });
}
