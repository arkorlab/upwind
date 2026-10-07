import { suiteVariablesOf } from './suite-env.ts';

/**
 * Prints the suite's variables as JSON (`suite-env.ts`): what the deploy hook was handed beyond the
 * environment of the harness whose pid it is given. Run by the hook before it sets anything of its own,
 * so what it reads is what the harness handed it.
 */
const [pid] = process.argv.slice(2);
const warn = (message: string): void => {
  console.error(
    `suite environment: ${message}; the deployment gets the application's .env files alone`,
  );
};
const variables = suiteVariablesOf(pid, process.env, warn);
// DIAGNOSTIC (not for merging): which names were taken, and how long each value is.
console.error(
  `suite environment (diagnostic): ${Object.entries(variables)
    .map(([name, value]) => `${name} (${String(value.length)})`)
    .join(', ')}`,
);
process.stdout.write(JSON.stringify(variables));
