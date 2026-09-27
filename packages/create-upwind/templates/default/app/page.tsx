export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-2xl font-semibold">upwind</h1>
      <p className="text-sm text-gray-500">
        Edit <code className="font-mono">app/page.tsx</code> to get started.
      </p>
      <a className="text-sm underline underline-offset-4" href="/__upwind">
        /__upwind
      </a>
    </main>
  );
}
