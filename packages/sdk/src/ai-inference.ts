import type { AiModels, ReadableStream } from '@cloudflare/workers-types';

type Primitive = string | number | boolean | bigint | symbol | null | undefined;
type PublicInputs<Input> = Input extends Primitive
  ? Input
  : Omit<Input, 'lora'> & { readonly lora?: never };
type StreamingInputs<Input> = Input extends unknown
  ? 'stream' extends keyof Input
    ? true extends Input['stream']
      ? Input
      : never
    : never
  : never;
type NonStreamingInputs<Input> = Input extends unknown
  ? 'stream' extends keyof Input
    ? Omit<Input, 'stream'> & { readonly stream?: Exclude<Input['stream'], true> }
    : Input
  : Input;
type Inputs<Name extends keyof AiModels> = PublicInputs<AiModels[Name]['inputs']>;

/** Public Workers AI inference; account management and gateway options are not capabilities. */
export interface AiInference {
  run<Name extends keyof AiModels>(
    model: Name,
    inputs: StreamingInputs<Inputs<Name>> & { stream: true },
  ): Promise<ReadableStream>;
  run<Name extends keyof AiModels>(
    model: Name,
    inputs: NonStreamingInputs<Inputs<Name>>,
  ): Promise<AiModels[Name]['postProcessedOutputs']>;
  run<Name extends keyof AiModels>(
    model: Name,
    inputs: StreamingInputs<Inputs<Name>> & { stream: boolean },
  ): Promise<AiModels[Name]['postProcessedOutputs'] | ReadableStream>;
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

interface Runner {
  readonly run: (...args: readonly unknown[]) => Promise<unknown>;
}

const wrappers = new WeakMap<Runner, AiInference>();

/** Keep the accessor's runtime surface as narrow as its type, including for JavaScript callers. */
export function inference(binding: unknown): AiInference {
  if (typeof binding !== 'object' || binding === null) {
    throw new TypeError('the published AI binding is not an inference capability');
  }
  const runner = binding as Runner;
  const cached = wrappers.get(runner);
  if (cached !== undefined) return cached;
  const wrapper = Object.freeze({
    async run(...args: readonly unknown[]): Promise<unknown> {
      if (args.length !== 2) {
        throw new TypeError('AI inference accepts only run(model, inputs)');
      }
      const inputs = args[1];
      if (typeof inputs === 'object' && inputs !== null && Object.hasOwn(inputs, 'lora')) {
        throw new TypeError('AI inference cannot include private LoRA adapters');
      }
      return await Reflect.apply(runner.run, runner, args);
    },
  }) as AiInference;
  wrappers.set(runner, wrapper);
  return wrapper;
}
