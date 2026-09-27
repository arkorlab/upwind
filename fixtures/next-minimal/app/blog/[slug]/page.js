/**
 * A `"use cache"` function handed promises made from `params`, which is what the
 * `hanging-input-abort` patch is about: a cached function's key is its arguments, and a promise
 * among them is keyed by what it resolves to. The last pass of a prerender waits for such a
 * promise and then gives up, and each of these chains is a few microtasks behind `params`.
 */
async function greet(slug) {
  'use cache';
  return `hello ${await slug}`;
}

export function generateStaticParams() {
  return [{ slug: 'first' }, { slug: 'second' }];
}

export default async function Page({ params }) {
  const slug = params.then((resolved) => resolved.slug);
  return (
    <>
      <p>{await greet(slug)}</p>
      <p>{await greet(slug.catch(() => 'none'))}</p>
      <p>{await greet(slug.finally(() => {}))}</p>
      <p>
        {await greet(
          slug
            .finally(() => {})
            .catch(() => 'none'),
        )}
      </p>
    </>
  );
}
