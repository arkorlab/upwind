import * as s from '@stayingupwind/core/schema';
import * as z from 'zod';

/**
 * core's schemas as zod schemas, for what still asks zod of them.
 *
 * What the edge reads is written with core's validator (`@stayingupwind/core/schema`): it is
 * cheap to build, and the edge builds every schema it imports before it answers its first request.
 * What composes those schemas into zod schemas of its own, or hands them to what only takes zod's
 * (`z.toJSONSchema`, a validator middleware), takes them through `toZod`: the zod schema that the
 * same source would have built with zod, check for check and in the same order, so that it takes,
 * returns and reports what core's does.
 */

/** Anything core's validator makes: what a shape's field is. */
type Typed = s.Shape[string];
type Check = s.Schema['checks'][number];

/** zod's handling of keys an object does not name, by core's name for it. */
type ObjectConfig<M extends s.UnknownKeys> = M extends 'strict'
  ? z.core.$strict
  : M extends 'loose'
    ? z.core.$loose
    : z.core.$strip;

/**
 * The zod schema `toZod` makes, as a type. An object is zod's object of the same fields, so that
 * `.extend()` and `.shape` read as they did; a list is zod's list of the same element. Anything
 * else is a schema of the same output and input, optional where core's is: what makes a key of a
 * zod object optional, going in and coming out, is the type of the schema it holds.
 */
export type ZodOf<S extends Typed> =
  S extends s.ObjectSchema<infer Fields, infer M>
    ? z.ZodObject<{ -readonly [K in keyof Fields]: ZodOf<Fields[K]> }, ObjectConfig<M>>
    : S extends s.ArraySchema<infer E>
      ? z.ZodArray<ZodOf<E>>
      : S['~types']['optout'] extends 'optional'
        ? z.ZodOptional<z.ZodType<Exclude<s.output<S>, undefined>, Exclude<s.input<S>, undefined>>>
        : S['~types']['optin'] extends 'defaulted'
          ? z.ZodDefault<z.ZodType<s.output<S>, Exclude<s.input<S>, undefined>>>
          : z.ZodType<s.output<S>, s.input<S>>;

/** zod's form of a check's message: absent where the check has none of its own. */
function paramsOf(message: string | undefined): { readonly message: string } | undefined {
  return message === undefined ? undefined : { message };
}

function refineParams(check: Extract<Check, { kind: 'refine' }>): z.core.$ZodCustomParams {
  return {
    ...(check.message !== undefined && { error: check.message }),
    ...(check.path !== undefined && { path: [...check.path] }),
  };
}

/** One of core's checks as zod's. `url` and `datetime` are not among them: they are the type. */
function zodCheck(check: Check): z.core.$ZodCheck {
  switch (check.kind) {
    case 'min_length': {
      return z.minLength(check.value, paramsOf(check.message));
    }
    case 'max_length': {
      return z.maxLength(check.value, paramsOf(check.message));
    }
    case 'length_equals': {
      return z.length(check.value, paramsOf(check.message));
    }
    case 'greater_than': {
      const params = paramsOf(check.message);
      return check.inclusive ? z.gte(check.value, params) : z.gt(check.value, params);
    }
    case 'less_than': {
      const params = paramsOf(check.message);
      return check.inclusive ? z.lte(check.value, params) : z.lt(check.value, params);
    }
    case 'safe_int': {
      return z.int(paramsOf(check.message));
    }
    case 'regex': {
      return z.regex(check.pattern, paramsOf(check.message));
    }
    case 'starts_with': {
      return z.startsWith(check.prefix, paramsOf(check.message));
    }
    case 'trim': {
      return z.trim();
    }
    case 'refine': {
      return z.refine(check.fn, refineParams(check));
    }
    case 'super_refine': {
      return z.superRefine(check.fn as Parameters<typeof z.superRefine>[0]);
    }
    case 'url':
    case 'datetime': {
      throw new Error(`A ${check.kind} check is a string's type, not a check of its own`);
    }
  }
}

/** A string: zod's `z.url()` or `z.iso.datetime()` where core's was made by `url()` or `datetime()`. */
function stringOf(schema: s.StringSchema): z.ZodType {
  const [first, ...rest] = schema.checks;
  if (first?.kind === 'url') {
    return withChecks(z.url(), rest);
  }
  if (first?.kind === 'datetime') {
    return withChecks(z.iso.datetime(), rest);
  }
  return withChecks(z.string(), schema.checks);
}

function withChecks(zod: z.ZodType, checks: readonly Check[]): z.ZodType {
  if (checks.length === 0) {
    return zod;
  }
  // Each check is one core chained on a schema of the type it checks, as it is chained here.
  return zod.check(...checks.map((check) => zodCheck(check) as z.core.$ZodCheck<unknown>));
}

function valueOf(schema: s.ValueSchema): z.ZodType {
  switch (schema.kind) {
    case 'boolean': {
      return z.boolean();
    }
    case 'null': {
      return z.null();
    }
    case 'unknown': {
      return z.unknown();
    }
    case 'literal': {
      return z.literal(schema.values as z.core.util.Literal[]);
    }
  }
}

function objectOf(schema: s.ObjectSchema): z.ZodType {
  const fields = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => [key, toZod(field)]),
  );
  switch (schema.unknownKeys) {
    case 'strict': {
      return z.strictObject(fields);
    }
    case 'loose': {
      return z.looseObject(fields);
    }
    case 'strip': {
      return z.object(fields);
    }
  }
}

function wrapperOf(schema: s.WrapperSchema): z.ZodType {
  const inner = toZod(schema.inner);
  switch (schema.wrapping) {
    case 'optional': {
      return inner.optional();
    }
    case 'nullable': {
      return inner.nullable();
    }
    case 'default': {
      // A function stays one: zod calls it for each value it fills in, as core does.
      return inner.default(schema.fallback);
    }
  }
}

function templateOf(schema: s.TemplateLiteralSchema): z.ZodType {
  return z.string().superRefine((input, ctx) => {
    if (!schema.matches(input)) {
      ctx.addIssue({
        code: 'invalid_format',
        format: 'template_literal',
        pattern: schema.pattern.source,
        input,
      });
    }
  });
}

/**
 * `instanceof`, narrowing a generic class to its parameters' constraints rather than to `any` in
 * each of them, which is what `instanceof` alone gives one.
 */
function isA<T extends s.Schema>(
  schema: s.Schema,
  kind: abstract new (...args: never[]) => T,
): schema is T {
  return schema instanceof kind;
}

/** The schema's own type, before the checks chained on it. */
function typeOf(schema: s.Schema): z.ZodType {
  if (schema instanceof s.StringSchema) {
    return stringOf(schema);
  }
  if (schema instanceof s.NumberSchema) {
    return schema.coerce ? z.coerce.number() : z.number();
  }
  if (schema instanceof s.ValueSchema) {
    return valueOf(schema);
  }
  if (schema instanceof s.EnumSchema) {
    return z.enum(schema.values as [string, ...string[]]);
  }
  if (isA(schema, s.ObjectSchema)) {
    return objectOf(schema);
  }
  if (schema instanceof s.ArraySchema) {
    return z.array(toZod(schema.element));
  }
  if (schema instanceof s.RecordSchema) {
    return z.record(toZod(schema.key) as z.ZodString, toZod(schema.value));
  }
  if (schema instanceof s.UnionSchema) {
    return z.union((schema.options as readonly Typed[]).map((option) => toZod(option)));
  }
  if (schema instanceof s.DiscriminatedUnionSchema) {
    const options = (schema.options as readonly Typed[]).map(
      (option) => toZod(option) as z.ZodObject,
    );
    return z.discriminatedUnion(schema.discriminator, options as [z.ZodObject, ...z.ZodObject[]]);
  }
  if (isA(schema, s.TemplateLiteralSchema)) {
    return templateOf(schema);
  }
  if (isA(schema, s.WrapperSchema)) {
    return wrapperOf(schema);
  }
  // Minified, a Worker's classes carry the minifier's names (`keep_names: false`), so the schema
  // itself goes with the error, as its cause, for what the name no longer says.
  throw new Error(`No zod schema is made of ${schema.constructor.name}`, { cause: schema });
}

/** Made once for each of core's schemas: zod's are immutable, so one serves every reader. */
const MADE = new WeakMap<Typed, z.ZodType>();

/**
 * The zod schema `schema` would have been, written with zod: it takes, returns and reports what
 * `schema` does, and `z.toJSONSchema` describes it as it described the zod original.
 */
export function toZod<const S extends Typed>(schema: S): ZodOf<S> {
  let zod = MADE.get(schema);
  if (zod === undefined) {
    const core = schema as unknown as s.Schema;
    const type = typeOf(core);
    // A string's checks are the string's own (`stringOf`), `url` and `datetime` among them.
    zod = core instanceof s.StringSchema ? type : withChecks(type, core.checks);
    if (core instanceof s.TemplateLiteralSchema) zod = zod.meta({ pattern: core.pattern.source });
    MADE.set(schema, zod);
  }
  return zod as unknown as ZodOf<S>;
}
