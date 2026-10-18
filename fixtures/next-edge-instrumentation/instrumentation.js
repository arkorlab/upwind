// This value import eagerly reaches Next's Edge globals; composition must precede their capture.
import { NextResponse } from 'next/server';

import { selectedCase, state } from './state.js';

export const ownIdentity = 'own-fixture';

export async function register() {
  const value = state();
  value.events.push('own:start');
  value.ownReceiver = this?.ownIdentity === ownIdentity;
  value.ownRuntime = process.env.NEXT_RUNTIME;
  // Keep the value import observable in the compiled hook, rather than only importing a type.
  if (NextResponse.json({ hook: 'own' }).status !== 200) throw new Error('fixture Next import');
  await new Promise((resolve) => setTimeout(resolve, 10));
  if (selectedCase() === 'own-register-throws') throw new Error('fixture own register failure');
  value.ownReady = true;
  value.events.push('own:end');
}

export async function onRequestError(...args) {
  const value = state();
  value.events.push('own:error');
  value.ownErrors += 1;
  value.ownErrorReceiver = this?.ownIdentity === ownIdentity;
  value.sameArguments = args.every((argument, index) => argument === value.hostArguments?.[index]);
  if (selectedCase() === 'own-error-throws') throw new Error('fixture own error hook failure');
}
