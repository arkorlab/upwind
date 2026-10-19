import { describe, expect, it } from 'vitest';

import { constSetterBodies } from '../src/const-export-setters.ts';

describe('constant export setter lexical scopes', () => {
  it.each([
    { source: 'const value=1; registry([p=>value=p]);', expected: ['value=p'] },
    { source: 'let value=1; registry([p=>value=p]);', expected: [] },
    { source: 'const {value}=input; registry([p=>value=p]);', expected: ['value=p'] },
    { source: 'const value=1; {let value=2; registry([p=>value=p]);}', expected: [] },
    { source: 'const value=1; function f(value){registry([p=>value=p]);}', expected: [] },
    {
      source: 'const value=1; function f(){registry([p=>value=p]); var value;}',
      expected: [],
    },
    {
      source: 'const value=1; function f(){const value=2; registry([p=>value=p]);}',
      expected: ['value=p'],
    },
    {
      source: 'const value=1; for(let value of input){registry([p=>value=p]);}',
      expected: [],
    },
    {
      source: 'const value=1; try{}catch(value){registry([p=>value=p]);}',
      expected: [],
    },
  ])('preserves the existing declaration lookup for $source', ({ source, expected }) => {
    const assignments = constSetterBodies(source).map(({ start, end }) => source.slice(start, end));

    expect(assignments).toStrictEqual(expected);
  });
});
