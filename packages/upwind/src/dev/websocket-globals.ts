/* eslint-disable unicorn/no-global-object-property-assignment -- Development supplies the missing native Pair/101 Response contract before Next defines its Response subclasses. */
import { Response as WorkerResponse, WebSocketPair } from 'miniflare';

const SWITCHING_PROTOCOLS = 101;

type Socket = InstanceType<typeof WebSocketPair>[0];
interface SocketInit extends ResponseInit {
  readonly webSocket?: Socket | null;
}

/** Keep Node fetch/NextResponse brands while admitting Cloudflare's native handshake response. */
export function installWebSocketGlobals(): () => void {
  const original = Response;
  const globals = globalThis as typeof globalThis & { WebSocketPair?: typeof WebSocketPair };
  const previousPair = globals.WebSocketPair;
  const facade: typeof Response = new Proxy(original, {
    construct(
      target,
      args: [BodyInit | null | undefined, SocketInit | undefined],
      derivedConstructor,
    ) {
      const [body, init] = args;
      const socket = init?.webSocket;
      if (socket === undefined || socket === null)
        return Reflect.construct(target, args, derivedConstructor) as Response;
      if (init?.status !== SWITCHING_PROTOCOLS || (body !== null && body !== undefined)) {
        throw new TypeError('A WebSocket response requires status 101 and a null body.');
      }
      // A Response can itself be the init object; its headers/statusText are prototype getters,
      // so spreading it alone would silently lose both on a forwarding copy.
      const response = Reflect.construct(
        target,
        [
          null,
          {
            ...init,
            status: 200,
            headers: init.headers,
            statusText: init.statusText,
          },
        ],
        derivedConstructor,
      ) as Response;
      Object.defineProperties(response, {
        status: { value: SWITCHING_PROTOCOLS },
        statusText: { value: 'Switching Protocols' },
        ok: { value: false },
        webSocket: { value: socket },
        clone: {
          value: () => {
            throw new TypeError('Cannot clone a WebSocket handshake response.');
          },
        },
      });
      return response;
    },
    get(target, key, receiver) {
      // The global accepts a proxied Durable Object fetch response too. Subclasses retain their
      // own prototype test: a plain fetch response is not thereby a NextResponse.
      if (receiver === facade && key === Symbol.hasInstance) {
        return (value: unknown): boolean =>
          value instanceof original || value instanceof WorkerResponse;
      }
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  globalThis.Response = facade;
  globals.WebSocketPair = WebSocketPair;
  return () => {
    if (Response === facade) globalThis.Response = original;
    if (globals.WebSocketPair === WebSocketPair) {
      if (previousPair === undefined) delete globals.WebSocketPair;
      else globals.WebSocketPair = previousPair;
    }
  };
}
