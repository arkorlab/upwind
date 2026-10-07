import { sleep } from 'workflow';

async function shout(name) {
  'use step';
  return `HELLO ${name.toUpperCase()}`;
}

/** A step, a sleep and a step: enough to put the engine and the steps into the flow route. */
export async function greet(name) {
  'use workflow';
  const loud = await shout(name);
  await sleep('1s');
  return shout(loud);
}
