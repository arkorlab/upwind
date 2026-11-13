import {
  attribute,
  output,
  ref,
  resourceName,
  type Resources,
  substitute,
} from './template-values.ts';
import type { AwsDeploySettings } from './types.ts';

function cachePolicy(name: string, immutable: boolean): Record<string, unknown> {
  return {
    Type: 'AWS::CloudFront::CachePolicy',
    Properties: {
      CachePolicyConfig: {
        Name: name,
        DefaultTTL: immutable ? 31536000 : 0,
        MinTTL: 0,
        MaxTTL: immutable ? 31536000 : 0,
        ParametersInCacheKeyAndForwardedToOrigin: {
          CookiesConfig: { CookieBehavior: 'none' },
          HeadersConfig: { HeaderBehavior: 'none' },
          QueryStringsConfig: { QueryStringBehavior: 'none' },
          EnableAcceptEncodingBrotli: immutable,
          EnableAcceptEncodingGzip: immutable,
        },
      },
    },
  };
}

/** Enabled only after a verified build proves that native routing cannot condition these files. */
export function staticCacheBehaviors(): readonly Record<string, unknown>[] {
  return [
    {
      PathPattern: '/_next/static/*',
      TargetOriginId: 'static',
      ViewerProtocolPolicy: 'redirect-to-https',
      AllowedMethods: ['GET', 'HEAD', 'OPTIONS'],
      CachedMethods: ['GET', 'HEAD'],
      CachePolicyId: ref('StaticCachePolicy'),
      Compress: true,
    },
  ];
}

export function cdnResources(
  project: string,
  settings: AwsDeploySettings,
  staticBypass = false,
): Resources {
  if (!settings.cloudFront) return {};
  const name = resourceName(project);
  const custom = settings.publicOrigin !== undefined;
  if (custom && settings.certificateArn === undefined) {
    throw new Error('a custom CloudFront public origin requires an ACM certificate in us-east-1');
  }
  return {
    VpcOrigin: {
      Type: 'AWS::CloudFront::VpcOrigin',
      DependsOn: 'InternetGatewayAttachment',
      Properties: {
        VpcOriginEndpointConfig: {
          Name: `${name}-origin`,
          Arn: ref('LoadBalancer'),
          HTTPPort: 80,
          HTTPSPort: 443,
          OriginProtocolPolicy: 'http-only',
          OriginSSLProtocols: ['TLSv1.2'],
        },
      },
    },
    DynamicCachePolicy: cachePolicy(`${name}-dynamic`, false),
    StaticCachePolicy: cachePolicy(`${name}-static`, true),
    ViewerRequestPolicy: {
      Type: 'AWS::CloudFront::OriginRequestPolicy',
      Properties: {
        OriginRequestPolicyConfig: {
          Name: `${name}-viewer`,
          HeadersConfig: { HeaderBehavior: 'allViewer' },
          CookiesConfig: { CookieBehavior: 'all' },
          QueryStringsConfig: { QueryStringBehavior: 'all' },
        },
      },
    },
    StaticOriginAccess: {
      Type: 'AWS::CloudFront::OriginAccessControl',
      Properties: {
        OriginAccessControlConfig: {
          Name: `${name}-static`,
          OriginAccessControlOriginType: 's3',
          SigningBehavior: 'always',
          SigningProtocol: 'sigv4',
        },
      },
    },
    Distribution: {
      Type: 'AWS::CloudFront::Distribution',
      Properties: {
        DistributionConfig: {
          Enabled: true,
          Comment: `upwind ${project}`,
          HttpVersion: 'http2and3',
          IPV6Enabled: true,
          ...(custom && { Aliases: [new URL(settings.publicOrigin ?? '').hostname] }),
          ViewerCertificate: custom
            ? {
                AcmCertificateArn: settings.certificateArn,
                SslSupportMethod: 'sni-only',
                MinimumProtocolVersion: 'TLSv1.2_2021',
              }
            : { CloudFrontDefaultCertificate: true },
          Origins: [
            {
              Id: 'application',
              DomainName: attribute('LoadBalancer', 'DNSName'),
              VpcOriginConfig: {
                VpcOriginId: attribute('VpcOrigin', 'Id'),
                OriginReadTimeout: 60,
                OriginKeepaliveTimeout: 60,
              },
            },
            {
              Id: 'static',
              DomainName: attribute('Artifacts', 'RegionalDomainName'),
              OriginPath: '/static',
              OriginAccessControlId: ref('StaticOriginAccess'),
              S3OriginConfig: { OriginAccessIdentity: '' },
            },
          ],
          DefaultCacheBehavior: {
            TargetOriginId: 'application',
            ViewerProtocolPolicy: 'redirect-to-https',
            AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'],
            CachedMethods: ['GET', 'HEAD'],
            CachePolicyId: ref('DynamicCachePolicy'),
            OriginRequestPolicyId: ref('ViewerRequestPolicy'),
            Compress: false,
          },
          CacheBehaviors: staticBypass ? staticCacheBehaviors() : [],
          CustomErrorResponses: [403, 404, 500, 502, 503, 504].map((code) => ({
            ErrorCode: code,
            ErrorCachingMinTTL: 0,
          })),
        },
      },
    },
    ArtifactsPolicy: {
      Type: 'AWS::S3::BucketPolicy',
      Properties: {
        Bucket: ref('Artifacts'),
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { Service: 'cloudfront.amazonaws.com' },
              Action: 's3:GetObject',
              Resource: substitute('${Artifacts.Arn}/static/*'),
              Condition: {
                StringEquals: {
                  'AWS:SourceArn': substitute(
                    'arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${Distribution}',
                  ),
                },
              },
            },
          ],
        },
      },
    },
  };
}

export function cdnOutputs(settings: AwsDeploySettings): Record<string, Record<string, unknown>> {
  return {
    PublicOrigin: output(
      settings.publicOrigin ?? {
        'Fn::Join': ['', ['https://', attribute('Distribution', 'DomainName')]],
      },
    ),
    ...(settings.cloudFront && { DistributionId: output(ref('Distribution')) }),
  };
}
