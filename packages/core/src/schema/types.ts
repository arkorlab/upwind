/**
 * The types a schema stands for, worked out as zod 4 works out its own, so that `z.infer` of a
 * schema written the same way names the same type.
 */

/** Whether a key may be left out of what a schema is given: `optional`, or `defaulted` when it fills one in. */
export type OptIn = 'optional' | 'defaulted' | undefined;
/** Whether a key may be left out of what a schema returns. */
export type OptOut = 'optional' | undefined;

/** What every schema declares about itself; types only, nothing at run time. */
export interface TypeMarks<Out, In, I extends OptIn, O extends OptOut> {
  readonly output: Out;
  readonly input: In;
  readonly optin: I;
  readonly optout: O;
}

/** Anything that declares its types, which every schema does. */
export interface Typed {
  readonly '~types': TypeMarks<unknown, unknown, OptIn, OptOut>;
}

export type Output<T extends Typed> = T['~types']['output'];
export type Input<T extends Typed> = T['~types']['input'];

/** A value a literal may be, and a template literal may interpolate. */
export type Primitive = string | number | bigint | boolean | null | undefined;

export type NoUndefined<T> = T extends undefined ? never : T;

/** The fields of an object schema. */
export type Shape = Readonly<Record<string, Typed>>;

/** What an object schema does with keys its shape does not name. */
export type UnknownKeys = 'strip' | 'strict' | 'loose';

/** A type written out as one object, as zod's `Prettify` does. */
type Flatten<T> = { [K in keyof T]: T[K] };

type LooseExtra<M extends UnknownKeys> = M extends 'loose' ? Record<string, unknown> : unknown;

export type ObjectOutput<S extends Shape, M extends UnknownKeys> = Flatten<
  LooseExtra<M> & {
    -readonly [K in keyof S as S[K]['~types']['optout'] extends 'optional' ? K : never]?: Output<
      S[K]
    >;
  } & {
    -readonly [K in keyof S as S[K]['~types']['optout'] extends 'optional' ? never : K]: Output<
      S[K]
    >;
  }
>;

export type ObjectInput<S extends Shape, M extends UnknownKeys> = Flatten<
  LooseExtra<M> & {
    -readonly [
      K in keyof S as S[K]['~types']['optin'] extends 'optional' | 'defaulted' ? K : never
    ]?: Input<S[K]>;
  } & {
    -readonly [
      K in keyof S as S[K]['~types']['optin'] extends 'optional' | 'defaulted' ? never : K
    ]: Input<S[K]>;
  }
>;

/** A shape with `U`'s fields laid over `S`'s, as `.extend()` lays them. */
export type Extend<S extends Shape, U extends Shape> = Flatten<
  { [K in keyof S as K extends keyof U ? never : K]: S[K] } & { [K in keyof U]: U[K] }
>;

/** One part of a template literal as the string it stands for. */
type PartOutput<P> = P extends Typed
  ? Output<P> extends Primitive
    ? `${Output<P>}`
    : never
  : P extends Primitive
    ? `${P}`
    : never;

export type TemplateOutput<Parts extends readonly unknown[]> = Parts extends readonly [
  infer Head,
  ...infer Rest,
]
  ? `${PartOutput<Head>}${TemplateOutput<Rest>}`
  : '';
