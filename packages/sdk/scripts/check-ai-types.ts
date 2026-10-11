import type { ReadableStream } from '@cloudflare/workers-types';

import type { AiInference } from '../src/ai-inference.ts';

/** Compiled by the SDK typecheck; deliberately never invokes an inference. */
function publicTypes(ai: AiInference): void {
  const output = ai.run('@cf/meta/llama-2-7b-chat-int8', { prompt: 'Hello' });
  const stream: Promise<ReadableStream> = ai.run('@cf/meta/llama-2-7b-chat-int8', {
    prompt: 'Hello',
    stream: true,
  });
  const newer: Promise<unknown> = ai.run('@cf/example/new-model', { prompt: 'Hello' });
  // @ts-expect-error Known models must not fall back to the unknown-model overload.
  ai.run('@cf/meta/llama-2-7b-chat-int8', { wrong: true });
  // @ts-expect-error Account-wide gateway options are not inference capabilities.
  ai.run('@cf/meta/llama-2-7b-chat-int8', { prompt: 'Hello' }, { gateway: { id: 'other' } });
  // @ts-expect-error Private account LoRA assets are not public inference inputs.
  ai.run('@cf/meta/llama-2-7b-chat-int8', { prompt: 'Hello', lora: 'private' });
  // @ts-expect-error The capability exposes no account management API.
  ai.gateway('other');
  void output;
  void stream;
  void newer;
}

void publicTypes;
