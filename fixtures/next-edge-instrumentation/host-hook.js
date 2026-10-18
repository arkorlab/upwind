import { target } from 'instrumentation-runtime-target';

import { selectedCase, state } from './state.js';

if (selectedCase() === 'host-load-throws') throw new Error('fixture host load failure');

export const hostIdentity = 'host-fixture';

export async function register() {
  const value = state();
  value.events.push('host:start');
  value.hostReceiver = this?.hostIdentity === hostIdentity;
  value.hostRuntime = process.env.NEXT_RUNTIME;
  value.hostTarget = target;
  await new Promise((resolve) => setTimeout(resolve, 10));
  if (selectedCase() === 'host-register-throws') throw new Error('fixture host register failure');
  value.hostReady = true;
  value.events.push('host:end');
}

export async function onRequestError(...args) {
  const value = state();
  value.events.push('host:error');
  value.hostErrors += 1;
  value.hostErrorReceiver = this?.hostIdentity === hostIdentity;
  value.hostArguments = args;
  const [error, request, context] = args;
  value.error = {
    message: error.message,
    path: request.path,
    method: request.method,
    routeType: context.routeType,
  };
  if (selectedCase() === 'host-error-throws') throw new Error('fixture host error hook failure');
}

