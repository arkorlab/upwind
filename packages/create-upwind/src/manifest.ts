import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ownRange } from './version.ts';

/**
 * The `package.json` a scaffolded project starts with.
 *
 * Written rather than shipped in the template, so the name is the directory's and the versions are
 * this release's. Two of them are the whole point of the file:
 *
 * - **`next`, `react`, `react-dom` are dependencies, not suggestions.** upwind runs the *project's*
 *   Next.js — `upwind dev` resolves it from the project and refuses to start without it — so an
 *   application that upwind can run is one that has Next.js of its own.
 * - **`upwind` and the adapter come from this release.** `create-upwind@x.y.z` asks for `^x.y.z` of
 *   both, and the release publishes them from one tag, so a scaffolded project is wired to the
 *   generation that scaffolded it.
 *
 * The rest is what Next.js 16 and Tailwind 4 need, and nothing else: no ESLint, no `src/`, no
 * component library. `create-next-app --empty` is the shape.
 */

/** What the template is written against. */
const VERSIONS = {
  '@tailwindcss/postcss': '^4.3.3',
  '@types/node': '^24.13.4',
  '@types/react': '^19.3.0',
  '@types/react-dom': '^19.3.0',
  next: '^16.3.6',
  react: '^19.3.0',
  'react-dom': '^19.3.0',
  tailwindcss: '^4.3.3',
  typescript: '^5.9.3',
} as const;

export async function writeManifest(target: string, name: string): Promise<void> {
  const upwind = await ownRange();
  const manifest = {
    name,
    version: '0.1.0',
    // Nothing here is meant for a registry, and npm refuses to publish what says so.
    private: true,
    scripts: {
      dev: 'upwind dev',
      build: 'upwind build',
    },
    dependencies: {
      next: VERSIONS.next,
      react: VERSIONS.react,
      'react-dom': VERSIONS['react-dom'],
    },
    devDependencies: {
      '@stayingupwind/adapter': upwind,
      '@tailwindcss/postcss': VERSIONS['@tailwindcss/postcss'],
      '@types/node': VERSIONS['@types/node'],
      '@types/react': VERSIONS['@types/react'],
      '@types/react-dom': VERSIONS['@types/react-dom'],
      tailwindcss: VERSIONS.tailwindcss,
      typescript: VERSIONS.typescript,
      upwind,
    },
  };
  await writeFile(path.join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}
