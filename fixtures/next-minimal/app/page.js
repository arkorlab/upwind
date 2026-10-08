async function CachedContent() {
  'use cache';
  return <p>next-minimal</p>;
}

export default function Page() {
  return <CachedContent />;
}
