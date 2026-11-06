import { defaultProvider } from '@aws-sdk/credential-provider-node';

// This executable is invoked with the original deployment environment and no project code.
// Its stdout is a private pipe consumed by awsCredentialProvider, never a CLI log.
try {
  const identity = await defaultProvider()();
  process.stdout.write(JSON.stringify(identity));
} catch {
  process.exitCode = 1;
}
