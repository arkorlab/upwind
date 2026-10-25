import type { AppFunctions } from './app-functions.ts';
import type { BuiltFunction } from './function.ts';

/** What went into each Function, by its name, and the plan where the routes were split. */
export function dependencyRecord(
  functions: AppFunctions<unknown>,
  middleware: BuiltFunction | undefined,
): Record<string, unknown> {
  return {
    ...Object.fromEntries(functions.built.map((each) => [each.name, each.built.dependencies])),
    ...(middleware !== undefined && { middleware: middleware.dependencies }),
    ...(functions.plan !== undefined && { plan: functions.plan }),
  };
}
