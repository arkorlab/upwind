import { describe, expect, it } from 'vitest';

import { annotationOf } from '../src/annotate.ts';
import { hitsOfFile } from '../src/scan.ts';

describe('an annotation', () => {
  it('names the file, the line, the column and the term', () => {
    const [hit] = hitsOfFile('packages/host/a.ts', '// the dashboard');

    expect(hit && annotationOf(hit)).toBe(
      `::error file=packages/host/a.ts,line=1,col=8,title=vocabulary/dashboard::"dashboard": a host's own interface`,
    );
  });

  it("escapes what in a file's name would end a property or the command", () => {
    const [hit] = hitsOfFile('a,b:c\nd%.ts', '// the dashboard');

    expect(hit && annotationOf(hit)).toMatch(/^::error file=a%2Cb%3Ac%0Ad%25\.ts,line=1,/u);
  });
});
