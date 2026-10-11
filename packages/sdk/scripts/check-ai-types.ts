import type { AiModels, ReadableStream } from '@cloudflare/workers-types';

import type { AiInference } from '../src/ai-inference.ts';

/** Compiled by the SDK typecheck; deliberately never invokes an inference. */
const MODEL = '@cf/meta/llama-2-7b-chat-int8';
const FUTURE_AUDIO = '@cf/example/new-audio';
const FUTURE_MODEL = '@cf/example/new-model';

export async function publicTypes(ai: AiInference, streaming: boolean): Promise<void> {
  const output = ai.run(MODEL, { prompt: 'Hello' });
  const stream: Promise<ReadableStream> = ai.run(MODEL, {
    prompt: 'Hello',
    stream: true,
  });
  const newer: Promise<unknown> = ai.run(FUTURE_MODEL, { prompt: 'Hello' });
  const futureAudio = ai.run(FUTURE_AUDIO, 'encoded-audio');
  const futureBinary = ai.run(FUTURE_AUDIO, new Uint8Array([1, 2]));
  const futureStream = ai.run(FUTURE_AUDIO, await stream);
  const dynamic = ai.run(MODEL, { prompt: 'Hello', stream: streaming });
  const dynamicOutput: Awaited<typeof output> | ReadableStream = await dynamic;
  const inferDeclared = (
    inputs: AiModels[typeof MODEL]['inputs'],
  ): Promise<Awaited<typeof output> | ReadableStream> => ai.run(MODEL, inputs);
  const declared = inferDeclared({ prompt: 'Hello', stream: streaming });
  const audio = ai.run('@cf/openai/whisper', 'encoded-audio');
  const nullable = ai.run('@cf/moonshotai/kimi-k2.5', {
    messages: [{ role: 'user', content: 'Hello' }],
    stream: null,
  });
  const nullableOutput: Promise<AiModels['@cf/moonshotai/kimi-k2.5']['postProcessedOutputs']> =
    nullable;
  // @ts-expect-error Embedding models do not accept streaming input.
  await ai.run('@cf/baai/bge-small-en-v1.5', { text: 'Hello', stream: true });
  // @ts-expect-error A boolean stream flag cannot promise a JSON-only result.
  const jsonOnly: typeof output = dynamic;
  // @ts-expect-error Known models must not fall back to the unknown-model overload.
  await ai.run(MODEL, { wrong: true });
  // @ts-expect-error Account-wide gateway options are not inference capabilities.
  await ai.run(MODEL, { prompt: 'Hello' }, { gateway: { id: 'other' } });
  // @ts-expect-error Private account LoRA assets are not public inference inputs.
  await ai.run(MODEL, { prompt: 'Hello', lora: 'private' });
  // @ts-expect-error Future models cannot open access to private LoRA assets either.
  await ai.run(FUTURE_MODEL, { prompt: 'Hello', lora: 'private' });
  // @ts-expect-error Batch result polling is outside this inference capability.
  await ai.run('@cf/baai/bge-m3', { request_id: 'batch' });
  // @ts-expect-error Batch creation payloads are not inference inputs.
  await ai.run('@cf/baai/bge-m3', { requests: [{ text: 'Hello' }] });
  // @ts-expect-error New model typing cannot allow batch polling either.
  await ai.run(FUTURE_MODEL, { request_id: 'batch' });
  // @ts-expect-error The capability exposes no account management API.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Negative type assertion deliberately calls an absent method.
  await ai.gateway('other');
  await Promise.all([
    output,
    stream,
    newer,
    futureAudio,
    futureBinary,
    futureStream,
    audio,
    nullableOutput,
    declared,
    Promise.resolve(dynamicOutput),
    jsonOnly,
  ]);
}
