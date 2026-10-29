export default {
  cacheComponents: true,
  basePath: process.env.UPWIND_WEBSOCKET_BASE_PATH ?? '',
  assetPrefix: process.env.UPWIND_WEBSOCKET_ASSET_PREFIX ?? '',
  serverExternalPackages: ['ws', 'socket.io', 'engine.io'],
};
