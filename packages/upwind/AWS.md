# Deploy to AWS

upwind can deploy a native Next.js application entirely within your AWS account. No Cloudflare
account, runtime, or storage is required. AWS is a deployment provider; `compute` selects its
execution target. Fargate is the first driver. The CLI and shared cache contracts are separate
from that driver so another execution target can supply its own build and lifecycle implementation.

```ts
export default {
  deploy: {
    target: 'aws',
    name: 'shop',
    secrets: ['AUTH_SECRET'],
    aws: {
      region: 'ap-northeast-1',
      compute: 'fargate',
      tasks: 2,
      cloudFront: true,
      cache: { backend: 'valkey' },
    },
  },
};
```

```sh
AWS_PROFILE=deployment pnpm upwind deploy
pnpm upwind deployments
pnpm upwind rollback --to dpl_...
pnpm upwind destroy --yes
```

Every command uses the same project configuration and AWS authentication. The standard AWS SDK
credential chain supports environment credentials, profiles, SSO, web identity/OIDC and workload
roles. Authentication is resolved in an isolated helper process; deployment credential variables
are removed before the project's configuration executes and are never forwarded to its build.
The deployment identity needs permission to create and manage the resources described below,
including CloudFormation IAM resources and passing the generated execution and task roles.

## What is created

CloudFormation manages a project VPC, two availability zones, private task subnets and NAT egress,
security groups, ECR, ECS, an ALB, S3 artifacts, a shared cache, Secrets Manager and CloudWatch logs.
Each deployment has its own image digest, task definition, service and target group. Application
tasks accept requests from their load balancer. The CLI owns the production forwarding rule
separately from CloudFormation, so an infrastructure update cannot reset the live deployment.

`region` is required. Defaults are two tasks, 1024 CPU units, 2048 MiB of memory and `x86_64`.
`tasks`, `cpu`, `memoryMiB` and `architecture: 'arm64'` may be configured. CPU and memory must form a
supported Fargate Linux pair. Tasks stay running; this target does not scale to zero while live or
configure automatic scaling. A deployment's old tasks are scaled to zero after replacement and
connection draining. `keep`, default 5, retains their artifacts, settings and cache scopes for
rollback; rollback starts and checks the selected service before switching traffic.

The initial project configuration fixes its CDN mode, cache backend and shared infrastructure
settings. Changing those settings requires a different `deploy.name`; automatic infrastructure
or cache-backend migration is not provided. Task size and count can change on a new deployment.

## CloudFront is optional

With `cloudFront: true` (the default), upwind provides an HTTPS `*.cloudfront.net` address and a
private VPC origin in front of an internal ALB. Dynamic requests preserve viewer headers, cookies
and query strings, bypass CDN caching and stream from the native runtime. Immutable static files
are retained in S3 and prepared before a task becomes ready, so an ALB switch does not remove an
older deployment's assets. Native routing, middleware and configured headers still apply.
Task preparation follows the deployment retention window: expired deployment manifests are
removed, while immutable S3 objects stay available until project destruction.

To use the ALB directly:

```ts
aws: {
  region: 'ap-northeast-1',
  compute: 'fargate',
  cloudFront: false,
  publicOrigin: 'https://app.example.com',
  certificateArn: 'arn:aws:acm:ap-northeast-1:123456789012:certificate/11111111-1111-1111-1111-111111111111',
  cache: { backend: 'dynamodb' },
}
```

Use an issued ACM certificate covering that hostname in the deployment region. Point your DNS
at the generated ALB. upwind does not register a domain or take over its DNS. The public origin
is trusted configuration; visitor-supplied forwarding and internal control headers are discarded.
An ALB's generated AWS hostname cannot provide verified HTTPS for your application by itself.

The native server flushes headers before consuming the response body. PPR does not wait for its
deferred render to finish. The ALB idle timeout is 60 seconds, Node keep-alive is 65 seconds,
target deregistration delay is 300 seconds and task stop timeout is 60 seconds. Accepted work
drains under the native runtime's existing 30-second shutdown deadline.

## Choose a shared cache

Both backends implement the same runtime cache contract: ISR, Cache Components, data values,
tag invalidation, generation leases, fencing and ordered writes are shared across tasks.
Neither backend falls back to an independent local cache during an outage.

- **`valkey`**, the default, uses node-based ElastiCache Valkey 9 with synchronous durability,
  cluster mode, a primary and replica in separate availability zones, TLS and `noeviction`.
  `cache.nodeType` defaults to `cache.m7g.large`. This has a standing infrastructure cost.
  Primary reads preserve acknowledged invalidations across failover. upwind verifies the engine
  family and effective synchronous durability instead of falling back to a weaker mode.
- **`dynamodb`** uses strongly consistent metadata reads and conditional transactions, with S3
  for immutable generation metadata and bodies. A bounded invalidation log protects reads while
  tag projections are updated in the background. Partial projection, retries and task replacement
  do not make an acknowledged invalidation disappear. This trades more request-time storage
  operations for consumption-based metadata storage.

The existing 128-tag invalidation and 1024-tag generation limits apply to both backends.
Metadata is published only after its immutable S3 objects have been stored successfully.
Tasks synchronize authoritative tag revisions before reusing runtime memoized values.

## Build and deploy separately

Docker with Buildx is required. Install and build run on the selected Linux platform using the
same resolved Node image digest as the final image; a macOS native artifact cannot be copied into
Fargate. The final image contains the relocatable native artifact and runs as a non-root user.

```sh
pnpm upwind deploy --build-only    # no AWS credentials or account access
pnpm upwind deploy --prebuilt      # validate, upload and deploy that exact artifact
pnpm upwind deploy --dry-run       # describe the configuration/resources; change nothing
```

`--build-only` writes `.arkor/fargate/image.tar`, `deployment.json` and the native artifact.
The receipt records the execution target, deployment identity, platform, Node version/ABI,
base-image digest, image identity and content hashes. `--prebuilt` validates the archive against
its receipt and extracted artifact before changing AWS resources, without reinstalling or
rebuilding the application. Keep the entire output directory when moving between CI jobs.

For a monorepo, set a context containing the application, controlling lockfile and dependencies:

```ts
build: {
  context: '../..',
  prepare: ['pnpm', '--filter', './packages/*', 'build'],
  env: ['NEXT_PUBLIC_API_URL'],
}
```

Paths are relative to the application directory; the default context is `.`. `prepare` is an
argument vector run at the context root after the frozen installation. The application then runs
`upwind build --target=node` with the AWS host selected. The package manager comes from the
context's `packageManager` and lockfile. Yarn must use the node-modules linker. Host
`node_modules`, Git metadata, generated output, environment files and cloud credentials are
excluded. Only explicitly named build variables are mounted as BuildKit secrets. A context-root `.npmrc` is mounted separately as a build secret; registry token variables must also be explicitly listed in `build.env`. Runtime
`deploy.secrets` and `--env-file` values are stored separately in Secrets Manager.

## Failures, rollback and deletion

A candidate must pass readiness, report its own deployment identity and answer every
`deploy.checks` path before production is switched. Failed staging preserves the current service.
The production rule is read back before the new deployment is recorded as live. A project lock
serializes deploy, rollback and destroy. An uncertain provider mutation retains the lock and
reports its S3 location for recovery after that AWS operation has settled.

`destroy --yes` removes every AWS resource upwind manages, including internal cache data,
artifacts, images, secrets and networking. This target does not provision application-owned
`deploy.storage` stores, so `--include-storage` has no additional AWS effect. A failed deletion
reports remaining resources; it does not silently retain a billable bootstrap stack.

Native Node.js feature restrictions apply: Cloudflare storage bindings, Durable Objects,
Cloudflare Workflows, route gates, host cron jobs and edge CSP nonce handling are not provided.
Unsupported settings fail before provisioning. Next.js application instrumentation, middleware,
Server Actions, ISR, Cache Components and PPR use the native runtime.

Implementation references: [AWS VPC origins](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html),
[Valkey consistency](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Durability.Consistency.html),
[DynamoDB transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html),
[Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting).
