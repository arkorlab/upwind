/** Independent hook checks, run on separate CI runners with their own fixtures and hosts. */
export const CHECK_GROUPS = [
  'host',
  'environment',
  'lifecycle-workspace',
  'install-manager',
] as const;

export type CheckGroup = (typeof CHECK_GROUPS)[number];

/** Reject a mistyped selector before a check creates an application, host or harness. */
export function selectCheckGroups(argv: readonly string[]): readonly CheckGroup[] {
  if (argv.length === 0) return CHECK_GROUPS;
  const [option, group] = argv;
  if (option !== '--group' || argv.length !== 2 || !CHECK_GROUPS.includes(group as CheckGroup)) {
    throw new Error(`usage: check.ts [--group <${CHECK_GROUPS.join('|')}>]`);
  }
  return [group as CheckGroup];
}
