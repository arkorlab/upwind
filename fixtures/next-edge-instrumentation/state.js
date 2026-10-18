const KEY = Symbol.for('upwind.instrumentation.fixture');

export function state() {
  return (globalThis[KEY] ??= { events: [], hostErrors: 0, ownErrors: 0, handled: 0 });
}

export function selectedCase() {
  return process.env.UPWIND_INSTRUMENTATION_CASE;
}

export function snapshot() {
  const value = state();
  return {
    events: value.events,
    hostErrors: value.hostErrors,
    ownErrors: value.ownErrors,
    handled: value.handled,
    hostReady: value.hostReady === true,
    ownReady: value.ownReady === true,
    hostReceiver: value.hostReceiver === true,
    ownReceiver: value.ownReceiver === true,
    hostErrorReceiver: value.hostErrorReceiver === true,
    ownErrorReceiver: value.ownErrorReceiver === true,
    sameArguments: value.sameArguments === true,
    hostRuntime: value.hostRuntime ?? null,
    hostTarget: value.hostTarget ?? null,
    ownRuntime: value.ownRuntime ?? null,
    error: value.error ?? null,
  };
}
