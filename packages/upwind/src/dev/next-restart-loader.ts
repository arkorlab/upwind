// eslint-disable-next-line n/no-unsupported-features/node-builtins -- synchronous same-realm hooks are available since Node 22.15; this CLI requires Node 24
import { registerHooks } from 'node:module';

import { NEXT_RESTART_SYMBOL } from './restart.ts';

const state = { installed: false };
const EXIT_CALL = /process\.exit\(\s*(?:[\w$]+\.)?RESTART_EXIT_CODE\s*\)/gu;

/** Change only the verified devtools restart call; native process.exit remains untouched. */
export function bridgeNextRestartSource(source: string): string {
  if ([...source.matchAll(EXIT_CALL)].length !== 1) {
    throw new Error(
      'upwind: this Next.js devtools restart module has an unsupported exit contract',
    );
  }
  return source.replaceAll(
    EXIT_CALL,
    () => `globalThis[Symbol.for(${JSON.stringify(NEXT_RESTART_SYMBOL)})]()`,
  );
}

/** Preserve Next's cache invalidation and telemetry before its final restart timer drains us. */
export function installNextRestartLoader(): void {
  if (state.installed) return;
  state.installed = true;
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (
        !url.endsWith('/next-devtools/server/restart-dev-server-middleware.js') ||
        result.source === undefined
      )
        return result;
      const source =
        typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
      return { ...result, source: bridgeNextRestartSource(source) };
    },
  });
}
