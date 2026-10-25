export default function Page({ value }) {
  return <p>{`native-pages:${value}`}</p>;
}

export async function getServerSideProps() {
  return { props: { value: 'request' } };
}
