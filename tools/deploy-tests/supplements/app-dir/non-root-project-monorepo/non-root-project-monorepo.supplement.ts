// Copied from Next.js (https://github.com/vercel/next.js) under the MIT license:
// Copyright (c) 2025 Vercel, Inc.
//
// From test/e2e/app-dir/non-root-project-monorepo/non-root-project-monorepo.test.ts
// at 4e5335a00314be7fbb2aace5e9be56a88e64e5a8 (v16.4.5).
//
// Run by upwind's deploy tests among what Next.js skips in deploy mode
// (tools/deploy-tests/README.md).
// Upstream expects Vercel's build directory, `/vercel/path0`, where the suite is deployed
// (`if (isNextDeploy)`); here these cases expect the directory the application was built in, as
// under `next start`. The cases that do not read that path are in the suite as it stands.
// Nothing else is changed.
import {
  nextTestSetup,
  FileRef,
  patchFileWithDeployEnvAssignments,
} from 'e2e-utils'
import * as path from 'path'
import { realpathSync } from 'fs'
import { pathToFileURL } from 'url'

describe('non-root-project-monorepo', () => {
  const { next, isTurbopack } = nextTestSetup({
    files: {
      apps: new FileRef(path.resolve(__dirname, 'apps')),
      packages: new FileRef(path.resolve(__dirname, 'packages')),
      // Deliberately shadows apps/web/content, to pin down which one a
      // `/`-rooted import resolves from.
      content: new FileRef(path.resolve(__dirname, 'content')),
      'vercel.json': new FileRef(path.resolve(__dirname, 'vercel.json')),
      'pnpm-workspace.yaml': `packages:
      - 'apps/*'
      - 'packages/*'
      `,
    },
    overrideFiles: {
      'apps/web/next.config.js': patchFileWithDeployEnvAssignments(
        path.join(__dirname, 'apps/web/next.config.js')
      ),
    },
    packageJson: require('./package.json'),
    buildCommand: 'pnpm build',
    startCommand: (global as any).isNextDev ? 'pnpm dev' : 'pnpm start',
    installCommand: 'pnpm i',
    env: { ENABLE_EXPERIMENTAL_COREPACK: '1' },
  })

  function sourceFileUrl(file: string) {
    // Turbopack expands Windows 8.3 names (e.g. RUNNER~1) in source paths.
    const testDir =
      process.platform === 'win32' && isTurbopack
        ? realpathSync.native(next.testDir)
        : realpathSync(next.testDir)
    const filePath = path.join(testDir, 'apps/web', file)
    return pathToFileURL(filePath).href
  }

  describe('import.meta.url', () => {
    it('should work during RSC', async () => {
      const $ = await next.render$('/import-meta-url-rsc')
      expect($('p').text()).toBe(
        sourceFileUrl('app/import-meta-url-rsc/page.tsx')
      )
    })

    it('should work during SSR', async () => {
      const $ = await next.render$('/import-meta-url-ssr')
      expect($('p').text()).toBe(
        sourceFileUrl('app/import-meta-url-ssr/page.tsx')
      )
    })

    // Verifies that non-URL-safe characters in file paths (here: a literal
    // space) are correctly percent-encoded in the resulting `file://` URI.
    describe('non-url-safe characters', () => {
      it('should encode special chars during RSC', async () => {
        const $ = await next.render$('/import-meta-url-encoded-rsc')
        expect($('p').text()).toBe(
          sourceFileUrl('app/import-meta-url-encoded-rsc/with space.ts')
        )
      })

      it('should encode special chars during SSR', async () => {
        const $ = await next.render$('/import-meta-url-encoded-ssr')
        expect($('p').text()).toBe(
          sourceFileUrl('app/import-meta-url-encoded-ssr/with space.ts')
        )
      })
    })
  })
})
