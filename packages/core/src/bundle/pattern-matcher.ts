/** Internal compatibility path for helpers also used by an application's own Function. */
export interface BuildPatternMatcher {
  test(source: string, flags: '' | 'i', value: string): boolean;
  exec(source: string, flags: '' | 'i', value: string): RegExpExecArray | null;
}

export const nativeBuildPatterns: BuildPatternMatcher = {
  // eslint-disable-next-line security/detect-non-literal-regexp
  test: (source, flags, value) => new RegExp(source, flags).test(value),
  // eslint-disable-next-line security/detect-non-literal-regexp
  exec: (source, flags, value) => new RegExp(source, flags).exec(value),
};
