import { createElement } from 'react';

export function getStaticPaths() {
  return { fallback: true, paths: [{ params: { slug: 'first' } }] };
}

export function getStaticProps({ params }) {
  return { props: { slug: params.slug } };
}

export default function Page({ slug }) {
  return createElement('p', undefined, slug);
}
