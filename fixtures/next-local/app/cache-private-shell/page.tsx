import { cacheLife, cacheTag } from 'next/cache';
import { cookies } from 'next/headers';
import { type ReactNode, Suspense } from 'react';

/** An account's shared configuration lifetime, beneath a request's private scope. */
// eslint-disable-next-line @typescript-eslint/require-await -- Next.js cache functions must be async.
async function configuration(orgId: string, projectId: string): Promise<string> {
  'use cache';
  cacheLife({ stale: 30, revalidate: 29, expire: 30 });
  cacheTag(`configuration:${orgId}:${projectId}`);
  return `configuration=${orgId}/${projectId};revision=${crypto.randomUUID()}`;
}

async function ProjectConfiguration(): Promise<ReactNode> {
  'use cache: private';
  cacheLife({ stale: 30 });
  // Request-only identity stands for an account's viewer gate; only stable IDs enter the
  // shared function. The build cannot know these arguments or embed its result in the shell.
  const jar = await cookies();
  const orgId = jar.get('fixture-org')?.value ?? 'guest';
  const projectId = jar.get('fixture-project')?.value ?? 'none';
  const value = await configuration(orgId, projectId);
  return <p id="configuration">{value}</p>;
}

export default function CachePrivateShell(): ReactNode {
  return (
    <main>
      <h1 id="cache-shell">private account shell</h1>
      <Suspense fallback={<p id="configuration-loading">loading configuration</p>}>
        <ProjectConfiguration />
      </Suspense>
    </main>
  );
}
