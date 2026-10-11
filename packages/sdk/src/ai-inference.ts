import type { AiModels, ReadableStream } from '@cloudflare/workers-types';

type PublicInputs<Input> = Input extends unknown
  ? Omit<Input, 'lora'> & { readonly lora?: never }
  : never;
type Inputs<Name extends keyof AiModels> = PublicInputs<AiModels[Name]['inputs']>;

/** Public Workers AI inference; account management and gateway options are not capabilities. */
export interface AiInference {
  run<Name extends keyof AiModels>(
    model: Name,
    inputs: Inputs<Name> & { stream: true },
  ): Promise<ReadableStream>;
  run<Name extends keyof AiModels>(
    model: Name,
    inputs: Inputs<Name>,
  ): Promise<AiModels[Name]['postProcessedOutputs']>;
  /** A newly published model can be used before this package's model types are updated. */
  run<Model extends string>(
    model: Model extends keyof AiModels ? never : Model,
    inputs: Record<string, unknown> & { stream: true; readonly lora?: never },
  ): Promise<ReadableStream>;
  run<Model extends string>(
    model: Model extends keyof AiModels ? never : Model,
    inputs: Record<string, unknown> & { readonly lora?: never },
  ): Promise<unknown>;
}

const wrappers = new WeakMap<object, AiInference>();

/** Keep the accessor's runtime surface as narrow as its type, including for JavaScript callers. */
export function inference(binding: unknown): AiInference {
  if (typeof binding !== 'object' || binding === null) {
    throw new TypeError('the published AI binding is not an inference capability');
  }
  const cached = wrappers.get(binding);
  if (cached !== undefined) return cached;
  const wrapper = Object.freeze({
    run(...args: readonly unknown[]): Promise<unknown> {
      if (args.length !== 2) {
        throw new TypeError('AI inference accepts only run(model, inputs)');
      }
      const { run } = binding as { run: (...values: readonly unknown[]) => Promise<unknown> };
      return Reflect.apply(run, binding, args);
    },
  }) as AiInference;
  wrappers.set(binding, wrapper);
  return wrapper;
}
