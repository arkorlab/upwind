import { MAX_APP_FUNCTIONS } from '@stayingupwind/core/bundle';
import { compareCodeUnits } from '@stayingupwind/core/util';
import { describe, expect, it } from 'vitest';

import { type PlanInput, type PlanItem, planFunctions, type PlanUnit } from '../src/plan.ts';

/**
 * How the planner spreads routes across app Functions: as few Functions as the budgets allow,
 * routes that share code together, the same plan whatever order it is handed things in.
 */

const KIB = 1024;

function code(bytes: number): PlanItem {
  return { bytes, code: true };
}

function data(bytes: number): PlanItem {
  return { bytes, code: false };
}

function unit(ids: string[], items: string[], documents = ids.length): PlanUnit {
  return { ids, items, documents };
}

function input(overrides: Partial<PlanInput> & Pick<PlanInput, 'units' | 'items'>): PlanInput {
  return {
    base: { bytes: 100 * KIB, codeBytes: 100 * KIB },
    budget: { maxBytes: 10_000 * KIB, maxCodeBytes: 400 * KIB },
    ...overrides,
  };
}

/** Two sections that share a library each, and a route handler that shares nothing. */
const SECTIONS = input({
  units: [
    unit(['/docs'], ['docs-ui', 'mdx']),
    unit(['/docs/[slug]'], ['docs-ui', 'mdx', 'docs-slug']),
    unit(['/account'], ['account-ui', 'charts']),
    unit(['/account/settings'], ['account-ui', 'forms']),
    unit(['/api/auth'], ['auth-sdk'], 0),
  ],
  items: new Map([
    ['account-ui', code(80 * KIB)],
    ['auth-sdk', code(200 * KIB)],
    ['charts', code(150 * KIB)],
    ['docs-slug', code(10 * KIB)],
    ['docs-ui', code(60 * KIB)],
    ['forms', code(30 * KIB)],
    ['mdx', code(120 * KIB)],
  ]),
});

describe('the plan', () => {
  it('is one Function when everything fits in one', () => {
    const plan = planFunctions({
      ...SECTIONS,
      budget: { maxBytes: 10_000 * KIB, maxCodeBytes: 10_000 * KIB },
    });

    expect(plan).toHaveLength(1);
    expect(plan[0]?.name).toBe('app');
    expect(plan[0]?.ids).toHaveLength(5);
  });

  it('puts routes that share their code together, and keeps every Function within the budget', () => {
    const plan = planFunctions(SECTIONS);
    const together = (a: string, b: string): boolean =>
      plan.some((planned) => planned.ids.includes(a) && planned.ids.includes(b));

    expect(together('/docs', '/docs/[slug]')).toBe(true);
    expect(together('/account', '/account/settings')).toBe(true);
    expect(together('/docs', '/account')).toBe(false);

    for (const planned of plan) {
      expect(planned.codeBytes).toBeLessThanOrEqual(400 * KIB);
    }
  });

  it('counts what every Function carries in each of them', () => {
    const plan = planFunctions(SECTIONS);
    const docs = plan.find((planned) => planned.ids.includes('/docs'));

    // The base, the docs section's own code, and nothing of any other section.
    expect(docs?.codeBytes).toBe(100 * KIB + (60 + 120 + 10) * KIB);
  });

  it('makes no more Functions than the budget needs', () => {
    // Room for any two sections side by side, but not for all three.
    const plan = planFunctions({
      ...SECTIONS,
      budget: { maxBytes: 10_000 * KIB, maxCodeBytes: 650 * KIB },
    });

    expect(plan).toHaveLength(2);
  });

  it('counts data against the size budget alone', () => {
    const heavy = input({
      units: [unit(['/a'], ['a', 'a-body']), unit(['/b'], ['b', 'b-body'])],
      items: new Map([
        ['a', code(10 * KIB)],
        ['a-body', data(600 * KIB)],
        ['b', code(10 * KIB)],
        ['b-body', data(600 * KIB)],
      ]),
      budget: { maxBytes: 1000 * KIB, maxCodeBytes: 10_000 * KIB },
    });

    expect(planFunctions(heavy)).toHaveLength(2);
    expect(
      planFunctions({ ...heavy, budget: { maxBytes: 10_000 * KIB, maxCodeBytes: KIB } }),
    ).toHaveLength(1);
  });

  it('is the same plan whatever order the routes and pieces come in', () => {
    const reversed = input({
      units: [...SECTIONS.units].toReversed().map((one) => {
        return {
          ...one,
          ids: [...one.ids].toReversed(),
          items: [...one.items].toReversed(),
        };
      }),
      items: new Map([...SECTIONS.items].toReversed()),
    });

    expect(planFunctions(reversed)).toStrictEqual(planFunctions(SECTIONS));
  });

  it('names the Function holding the most documents first, and the rest by their first route', () => {
    const plan = planFunctions(SECTIONS);
    const names = plan.map((planned) => planned.name);

    expect(names[0]).toBe('app');
    expect(names.slice(1)).toStrictEqual(names.slice(1).map((_, at) => `app-${String(at + 2)}`));
    // The route handler is no document, so whatever holds it is not the first unless it has to be.
    expect(plan[0]?.ids).not.toStrictEqual(['/api/auth']);
  });

  it('drops a budget no Function could meet rather than make a Function per route', () => {
    // The base alone is past the code budget: held to the letter, nothing could ever share.
    const plan = planFunctions({
      ...SECTIONS,
      base: { bytes: 500 * KIB, codeBytes: 500 * KIB },
      budget: { maxBytes: 10_000 * KIB, maxCodeBytes: 400 * KIB },
    });

    expect(plan).toHaveLength(1);
  });

  it('gives a route past a budget the others meet a Function of its own', () => {
    const units = [unit(['/heavy'], ['heavy']), unit(['/a'], ['a']), unit(['/b'], ['b'])];
    const items = new Map([
      ['a', code(50 * KIB)],
      ['b', code(50 * KIB)],
      ['heavy', code(900 * KIB)],
    ]);
    const plan = planFunctions(input({ units, items }));

    expect(plan.map((planned) => planned.ids)).toStrictEqual([['/a', '/b'], ['/heavy']]);
  });

  it('reserves a native owner slot before forcing the cheapest remaining Worker merge', () => {
    const ids = Array.from(
      { length: MAX_APP_FUNCTIONS },
      (_, at) => `/r${String(at).padStart(2, '0')}`,
    );
    const own = input({
      units: ids.map((id) => unit([id], [id])),
      items: new Map(ids.map((id) => [id, code(100 * KIB)])),
      base: { bytes: 0, codeBytes: 0 },
      budget: { maxBytes: 10_000 * KIB, maxCodeBytes: 150 * KIB },
    });
    const ordinary = planFunctions(own);
    const reserved = planFunctions({ ...own, reservedFunctions: 1 });
    const reversed = planFunctions({
      ...own,
      units: own.units.toReversed(),
      items: new Map([...own.items].toReversed()),
      reservedFunctions: 1,
    });

    expect(ordinary).toHaveLength(MAX_APP_FUNCTIONS);
    expect(planFunctions({ ...own, reservedFunctions: 0 })).toStrictEqual(ordinary);
    expect(reserved).toHaveLength(MAX_APP_FUNCTIONS - 1);
    expect(reserved.flatMap((planned) => planned.ids).toSorted(compareCodeUnits)).toStrictEqual(
      ids,
    );
    expect(reserved.filter((planned) => planned.ids.length === 2)).toHaveLength(1);
    expect(reversed).toStrictEqual(reserved);
  });

  it.each([-1, MAX_APP_FUNCTIONS, 1.5, NaN, Infinity])(
    'refuses invalid reserved Function count %s instead of relaxing the total cap',
    (reservedFunctions) => {
      expect(() => planFunctions({ ...SECTIONS, reservedFunctions })).toThrow(RangeError);
    },
  );

  it('makes no more Functions than a deployment may run as, whatever the budget', () => {
    const many = Array.from({ length: 40 }, (_, at) => `/r${String(at).padStart(2, '0')}`);
    const units = many.map((id) => unit([id], [id]));
    const items = new Map(many.map((id) => [id, code(100 * KIB)]));
    const plan = planFunctions(
      input({
        units,
        items,
        base: { bytes: 0, codeBytes: 0 },
        budget: { maxBytes: 10_000 * KIB, maxCodeBytes: 150 * KIB },
      }),
    );
    const placed = plan.flatMap((planned) => planned.ids);

    expect(plan).toHaveLength(32);
    expect(placed.toSorted((a, b) => a.localeCompare(b, 'en'))).toStrictEqual(many);
  });
});

describe('a route past the budget on its own', () => {
  it('takes in one whose code it mostly has, rather than carry that code twice', () => {
    const units = [
      unit(['/heavy'], ['sdk', 'heavy-page']),
      unit(['/heavy/image'], ['sdk', 'image']),
      unit(['/a'], ['a']),
    ];
    const items = new Map([
      ['a', code(50 * KIB)],
      ['heavy-page', code(10 * KIB)],
      ['image', code(5 * KIB)],
      ['sdk', code(900 * KIB)],
    ]);
    const plan = planFunctions(input({ units, items }));

    // The two documents together are the first Function: the most documents.
    expect(plan.map((planned) => planned.ids)).toStrictEqual([['/heavy', '/heavy/image'], ['/a']]);
  });

  it('keeps apart from one that shares little of its code', () => {
    const units = [
      unit(['/one'], ['sdk-one', 'common']),
      unit(['/two'], ['sdk-two', 'common']),
      unit(['/a'], ['a']),
    ];
    const items = new Map([
      ['a', code(50 * KIB)],
      ['common', code(10 * KIB)],
      ['sdk-one', code(900 * KIB)],
      ['sdk-two', code(900 * KIB)],
    ]);

    expect(planFunctions(input({ units, items }))).toHaveLength(3);
  });

  it('is the only way past the budget: two routes within it stay apart, however much they share', () => {
    const units = [unit(['/a'], ['shared', 'a']), unit(['/b'], ['shared', 'b'])];
    const items = new Map([
      ['a', code(100 * KIB)],
      ['b', code(100 * KIB)],
      ['shared', code(150 * KIB)],
    ]);

    expect(planFunctions(input({ units, items }))).toHaveLength(2);
  });
});

describe('what a route past the code budget takes in', () => {
  it('is never past the size budget, however much code the two share', () => {
    const units = [unit(['/one'], ['sdk']), unit(['/two'], ['sdk', 'body']), unit(['/a'], ['a'])];
    const items = new Map([
      ['a', code(50 * KIB)],
      ['body', data(900 * KIB)],
      ['sdk', code(900 * KIB)],
    ]);
    const plan = planFunctions(
      input({ units, items, budget: { maxBytes: 1000 * KIB, maxCodeBytes: 400 * KIB } }),
    );

    expect(
      plan.some((planned) => planned.ids.includes('/one') && planned.ids.includes('/two')),
    ).toBe(false);
  });
});
