// The native build resolves this entry's environment and transport at build time. Routing,
// request context, cache hooks and PPR continue to use the same request path as Workers.
// eslint-disable-next-line import-x/no-default-export -- the generated Function's documented entry
export { default } from '../function.ts';
export { closeNodeBridge } from './entry.ts';
export { configureImageCache } from './image-cache.ts';
