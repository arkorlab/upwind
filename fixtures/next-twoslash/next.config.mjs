import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** @type {import('next').NextConfig} */
export default {
  outputFileTracingIncludes: {
    '/': [
      path.relative(
        process.cwd(),
        path.resolve(require.resolve('typescript/package.json'), '..', 'lib', 'lib.*.d.ts'),
      ),
      './node_modules/@types/node/**',
    ],
  },
  serverExternalPackages: ['twoslash'],
};
