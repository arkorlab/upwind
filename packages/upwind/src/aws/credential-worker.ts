import { defaultProvider } from '@aws-sdk/credential-provider-node';

// This executable is invoked with the original deployment environment and no project code.
// IPC is separate from stdout/stderr produced by NODE_OPTIONS preload modules.
async function reply(value: object): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (process.send === undefined) {
      reject(new Error('credential helper requires IPC'));
      return;
    }
    process.send(value, (error: Error | null) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
  process.disconnect?.();
}
try {
  const identity = await defaultProvider()();
  await reply({ identity });
} catch (error) {
  // Error names diagnose credential-chain failures without disclosing SDK messages or values.
  await reply({
    error:
      error instanceof Error && /^[\w.-]{1,80}$/u.test(error.name)
        ? error.name
        : 'CredentialsProviderError',
  }).catch(() => undefined);
  process.exitCode = 1;
}
