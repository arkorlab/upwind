import { Suspense } from 'react';
import { connection } from 'next/server';

async function Deferred() {
  await connection();
  await fetch(`${process.env.UPWIND_NATIVE_CONTROL_ORIGIN}/dynamic`, { cache: 'no-store' });
  return <p>native-dynamic</p>;
}

export default function Page() {
  return <><p>native-shell</p><Suspense fallback={<p>native-pending</p>}><Deferred /></Suspense></>;
}
