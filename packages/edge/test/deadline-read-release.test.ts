import { isDeadlineError, readBoundedBody } from '@stayingupwind/core/util';
import { describe, expect, it } from 'vitest';

async function settled(pending: Promise<unknown>): Promise<'fulfilled' | 'rejected'> {
  try {
    await pending;
    return 'fulfilled';
  } catch {
    return 'rejected';
  }
}

describe('a native body whose remaining read budget is already exhausted', () => {
  it('owns the pending read rejection when cancellation ends the native source', async () => {
    const source = new IdentityTransformStream();
    const writer = source.writable.getWriter();
    const closed = settled(writer.closed);
    try {
      await expect(
        readBoundedBody(source.readable, { limit: 16, stallMs: 50, budgetMs: 0 }),
      ).rejects.toSatisfy(isDeadlineError);

      // Workerd exposes the readable cancellation to a native writer on its next write.
      const writing = settled(writer.write(new Uint8Array([1])));

      await expect(writing).resolves.toBe('rejected');
      await expect(closed).resolves.toBe('rejected');

      // Give the runtime a turn to detect an unobserved rejection from the original pending read.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    } finally {
      await settled(writer.abort());
      await closed;
    }
  });
});
