import type { TextBinding } from '@stayingupwind/deploy/bindings';

import type { Loopback } from './ports.ts';

/** The local host's listening port, also published to every application's Function. */
export const LOCAL_PORT_BINDING = 'PORT';
const MAX_PORT = 65_535;

function validPort(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_PORT;
}

/** An explicit port takes precedence over the application's PORT, as the Next.js CLI does. */
export function requestedRuntimePort(
  explicit: number | undefined,
  environment: Readonly<Record<string, string>> | undefined,
): number | undefined {
  const value = environment?.[LOCAL_PORT_BINDING];
  if (explicit === undefined && value === undefined) return undefined;
  const port = explicit ?? Number(value);
  if (
    !validPort(port) ||
    (explicit === undefined && (value === undefined || !/^\d+$/u.test(value)))
  )
    throw new Error('PORT must name a whole listening port from 0 to 65535');
  return port;
}

/** Port zero requested allocation; Functions get the concrete port, even at HTTP's default 80. */
export function runtimePortBinding(socket: Pick<Loopback, 'port'>): TextBinding {
  if (!validPort(socket.port) || socket.port === 0)
    throw new Error('the Function PORT needs the allocated listening port');
  return { name: LOCAL_PORT_BINDING, value: String(socket.port), secret: false };
}
