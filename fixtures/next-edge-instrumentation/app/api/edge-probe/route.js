import { snapshot, state } from '../../../state.js';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export function GET(request) {
  state().handled += 1;
  if (new URL(request.url).searchParams.has('throw')) throw new Error('fixture route failure');
  return Response.json(snapshot());
}
