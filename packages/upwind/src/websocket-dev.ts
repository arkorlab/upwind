// Preloaded in both the Next CLI and its server child. Resource startup happens only when the
// actual development server initializes, before it evaluates any application modules.
import { installWebSocketDev } from './dev/websocket-loader.ts';

installWebSocketDev();
