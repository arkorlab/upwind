export default function Page({ value }) {
  return <p>{`native-isr:${value}`}</p>;
}

export async function getStaticProps() {
  const origin = process.env.UPWIND_NATIVE_CONTROL_ORIGIN;
  const value = origin === undefined ? 'seed' : await (await fetch(`${origin}/value`)).text();
  return { props: { value }, revalidate: 3600 };
}
