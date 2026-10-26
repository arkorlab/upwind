import { fileURLToPath } from 'node:url';

import { rolldown } from 'rolldown';
import { describe, expect, it } from 'vitest';

describe('runtime privacy helper dependency graph', () => {
  it('keeps build pattern analysis out of the runtime privacy helper bundle', async () => {
    const input = fileURLToPath(new URL('../../core/src/bundle/static-pages.ts', import.meta.url));
    await using bundle = await rolldown({ input });
    const { output } = await bundle.generate({ format: 'esm' });
    const code = output
      .filter((item) => item.type === 'chunk')
      .map((item) => item.code)
      .join('\n');

    expect(code).not.toContain('BuildPatternBudget');
    expect(code).not.toContain('function patternCost');
    expect(code).not.toContain('the build exceeds the routing pattern execution budget');
  });
});
