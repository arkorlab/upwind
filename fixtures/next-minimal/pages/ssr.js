// `getServerSideProps` gives the Pages Router's other data path: an entrypoint of its own, named
// `/_next/data/<buildId>/ssr.json`, where `getStaticProps` in `hello.js` gives a prerender under
// the same kind of name. The adapter serves both from the name the client router asks for.
export function getServerSideProps() {
  return { props: { at: 'request time' } };
}

export default function Ssr({ at }) {
  return <p>{at}</p>;
}
