import { getHandler } from 'next/dist/server/route-modules/pages/pages-handler.js';
import { createElement } from 'react';

export function getServerSideProps() {
  globalThis.__upwind_public_pages_get_handler__ = getHandler;
  return { props: { message: 'fixed public Pages handler compiler input' } };
}

export default function Page({ message }) {
  return createElement('p', undefined, message);
}
