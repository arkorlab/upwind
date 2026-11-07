// Explicit operations only: a new or mutating command must retain its single-attempt contract.
const READ_ONLY_COMMANDS = new Set([
  'BatchGetImageCommand',
  'DescribeAvailabilityZonesCommand',
  'DescribeCacheEngineVersionsCommand',
  'DescribeImagesCommand',
  'DescribeManagedPrefixListsCommand',
  'DescribeReplicationGroupsCommand',
  'DescribeRulesCommand',
  'DescribeSecretCommand',
  'DescribeStackEventsCommand',
  'DescribeStacksCommand',
  'DescribeTagsCommand',
  'DescribeTargetHealthCommand',
  'DescribeTaskDefinitionCommand',
  'DescribeTasksCommand',
  'GetAuthorizationTokenCommand',
  'GetBucketTaggingCommand',
  'GetInvalidationCommand',
  'GetObjectCommand',
  'GetSecretValueCommand',
  'GetTemplateCommand',
  'HeadObjectCommand',
  'ListBucketsCommand',
  'ListImagesCommand',
  'ListObjectsV2Command',
  'ListSecretsCommand',
  'ListStackResourcesCommand',
  'ListStacksCommand',
]);

const THROTTLING_ERRORS = new Set([
  'Throttling',
  'ThrottlingException',
  'ThrottledException',
  'RequestThrottledException',
  'TooManyRequestsException',
  'ProvisionedThroughputExceededException',
  'TransactionInProgressException',
  'LimitExceededException',
  'PriorRequestNotComplete',
  'RequestThrottled',
  'EC2ThrottledException',
  'RequestLimitExceeded',
  'SlowDown',
  'BandwidthLimitExceeded',
]);

const TRANSIENT_ERRORS = new Set([
  'RequestTimeout',
  'RequestTimeoutException',
  'InternalError',
  'IDPCommunicationError',
  'TimeoutError',
  'NetworkingError',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

function retryDelay(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const name = 'name' in error && typeof error.name === 'string' ? error.name : undefined;
  if (name === 'AbortError') return undefined;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : name;
  const metadata = '$metadata' in error ? error.$metadata : undefined;
  const status =
    typeof metadata === 'object' && metadata !== null && 'httpStatusCode' in metadata
      ? metadata.httpStatusCode
      : undefined;
  const retryable = '$retryable' in error ? error.$retryable : undefined;
  if (
    status === 429 ||
    (name !== undefined && THROTTLING_ERRORS.has(name)) ||
    (typeof retryable === 'object' &&
      retryable !== null &&
      'throttling' in retryable &&
      retryable.throttling === true)
  )
    return 1000;
  if (
    (name !== undefined && TRANSIENT_ERRORS.has(name)) ||
    (code !== undefined && TRANSIENT_ERRORS.has(code)) ||
    (typeof status === 'number' && [500, 502, 503, 504].includes(status)) ||
    (typeof retryable === 'object' && retryable !== null)
  )
    return 100;
  return undefined;
}

/** Retry the entire read pipeline, including signing; mutation SDK retries remain disabled. */
export function readRetries(sleep: (milliseconds: number) => Promise<void>) {
  return <Input, Output>(
    next: (args: Input) => Promise<Output>,
    context: { commandName?: string },
  ) =>
    async (args: Input): Promise<Output> => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await next(args);
        } catch (error) {
          const delay = retryDelay(error);
          if (
            attempt >= 3 ||
            context.commandName === undefined ||
            !READ_ONLY_COMMANDS.has(context.commandName) ||
            delay === undefined
          )
            throw error;
          await sleep(Math.floor(Math.random() * delay * 2 ** (attempt - 1)));
        }
      }
    };
}
