import { connection } from 'next/server';

import Client from './client.js';

export default async function Page() {
  // This must render inside the Function, rather than pass by serving a prerendered HTML blob.
  await connection();
  return (
    <main>
      <p>external-output-server</p>
      <Client />
    </main>
  );
}
