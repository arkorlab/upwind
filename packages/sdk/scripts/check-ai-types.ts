import type { ReadableStream } from '@cloudflare/workers-types';

import type { AiInference } from '../src/ai-inference.ts';

/** Compiled by the SDK typecheck; deliberately never invokes an inference. */
const MODEL = '@cf/meta/llama-2-7b-chat-int8';

export async function publicTypes(ai: AiInference, streaming: boolean): Promise<void> {
  const output = ai.run(MODEL, { prompt: 'Hello' });
  const stream: Promise<ReadableStream> = ai.run(MODEL, {
    prompt: 'Hello',
    stream: true,
  });
  const newer: Promise<unknown> = ai.run('@cf/example/new-model', { prompt: 'Hello' });
  const dynamic = ai.run(MODEL, { prompt: 'Hello', stream: streaming });
  const dynamicOutput: Awaited<typeof output> | ReadableStream = await dynamic;
  const audio = ai.run('@cf/openai/whisper', 'encoded-audio');
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
  // @ts-expect-error The capability exposes no account management API.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Negative type assertion deliberately calls an absent method.
  await ai.gateway('other');
  await Promise.all([output, stream, newer, audio, Promise.resolve(dynamicOutput), jsonOnly]);
}
