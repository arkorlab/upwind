/**
 * A gate that lets `limit` calls out at once, and the rest out in the order they came: what a
 * piece of work that makes many calls of its own keeps to, where the runtime bounds how many a
 * Function may have open together and holds the rest back without saying which.
 */
export function inTurns(limit: number): <T>(call: () => Promise<T>) => Promise<T> {
  let free = limit;
  const waiting: (() => void)[] = [];
  const acquire = async (): Promise<void> => {
    if (free > 0) {
      free -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) {
      free += 1;
    } else {
      next();
    }
  };
  return async (call) => {
    await acquire();
    try {
      return await call();
    } finally {
      release();
    }
  };
}
