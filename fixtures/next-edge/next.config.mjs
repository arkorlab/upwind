/**
 * No Cache Components: Next.js refuses the `runtime` route segment config in a build that has it
 * ("Route segment config \"runtime\" is not compatible with `nextConfig.cacheComponents`"), which
 * is why the edge runtime is a fixture of its own.
 *
 * @type {import('next').NextConfig}
 */
export default {};
