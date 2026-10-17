/** The methods that ask for something and change nothing (RFC 9110, "Safe Methods"). */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

/** Whether a request with this method may change something: whether it is held to its end. */
export function changesSomething(method: string): boolean {
  return !SAFE_METHODS.has(method);
}
