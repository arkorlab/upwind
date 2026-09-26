/**
 * Cache Components is on because three of the adapter's patches only reach a build that has it:
 * the prerender task timers, the resume cache limit, and the module-loading cache signal.
 *
 * @type {import('next').NextConfig}
 */
export default {
  cacheComponents: true,
};
