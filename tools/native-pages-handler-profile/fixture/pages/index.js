import { createElement } from 'react';

export function getServerSideProps() {
  return { props: { message: 'fixed public Pages handler compiler input' } };
}

export default function Page({ message }) {
  return createElement('p', undefined, message);
}
