// The Pages Router beside the App Router: a second compiled server runtime in the graph, and the
// `_next/data` outputs the adapter serves from the name the client router asks for.
export function getStaticProps() {
  return { props: { greeting: 'hello' } };
}

export default function Hello({ greeting }) {
  return <p>{greeting}</p>;
}
