import { attribute, output, ref, resourceName, type Resources, tags } from './template-values.ts';
import type { AwsDeploySettings } from './types.ts';

export interface NetworkInput {
  readonly project: string;
  readonly settings: AwsDeploySettings;
  readonly availabilityZones: readonly string[];
  readonly cloudFrontPrefixListId?: string;
}

/** Two independent egress routes keep a task's AZ from depending on another AZ's NAT. */
export function networkResources(input: NetworkInput): Resources {
  const { project, settings, availabilityZones } = input;
  if (availabilityZones.length < 2 || availabilityZones[0] === availabilityZones[1]) {
    throw new Error('Fargate requires two distinct supported availability zones');
  }
  if (settings.cloudFront && input.cloudFrontPrefixListId === undefined) {
    throw new Error('the CloudFront origin-facing managed prefix list is required');
  }
  const resources: Resources = {
    Vpc: {
      Type: 'AWS::EC2::VPC',
      Properties: {
        CidrBlock: '10.42.0.0/16',
        EnableDnsSupport: true,
        EnableDnsHostnames: true,
        Tags: tags(project),
      },
    },
    InternetGateway: { Type: 'AWS::EC2::InternetGateway', Properties: { Tags: tags(project) } },
    InternetGatewayAttachment: {
      Type: 'AWS::EC2::VPCGatewayAttachment',
      Properties: { VpcId: ref('Vpc'), InternetGatewayId: ref('InternetGateway') },
    },
    PublicRouteTable: {
      Type: 'AWS::EC2::RouteTable',
      Properties: { VpcId: ref('Vpc'), Tags: tags(project) },
    },
    InternetRoute: {
      Type: 'AWS::EC2::Route',
      DependsOn: 'InternetGatewayAttachment',
      Properties: {
        RouteTableId: ref('PublicRouteTable'),
        DestinationCidrBlock: '0.0.0.0/0',
        GatewayId: ref('InternetGateway'),
      },
    },
    LoadBalancerSecurityGroup: {
      Type: 'AWS::EC2::SecurityGroup',
      Properties: {
        GroupDescription: 'upwind application entry point',
        VpcId: ref('Vpc'),
        SecurityGroupIngress: [
          {
            IpProtocol: 'tcp',
            FromPort: settings.cloudFront ? 80 : 443,
            ToPort: settings.cloudFront ? 80 : 443,
            ...(settings.cloudFront
              ? { SourcePrefixListId: input.cloudFrontPrefixListId }
              : { CidrIp: '0.0.0.0/0' }),
          },
        ],
        Tags: tags(project),
      },
    },
    TaskSecurityGroup: {
      Type: 'AWS::EC2::SecurityGroup',
      Properties: {
        GroupDescription: 'upwind tasks accept requests only from their load balancer',
        VpcId: ref('Vpc'),
        SecurityGroupIngress: [
          {
            IpProtocol: 'tcp',
            FromPort: 3000,
            ToPort: 3000,
            SourceSecurityGroupId: ref('LoadBalancerSecurityGroup'),
          },
        ],
        Tags: tags(project),
      },
    },
    LoadBalancer: {
      Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
      DependsOn: 'InternetGatewayAttachment',
      Properties: {
        Name: resourceName(project),
        Type: 'application',
        Scheme: settings.cloudFront ? 'internal' : 'internet-facing',
        SecurityGroups: [ref('LoadBalancerSecurityGroup')],
        Subnets: settings.cloudFront
          ? [ref('PrivateSubnet1'), ref('PrivateSubnet2')]
          : [ref('PublicSubnet1'), ref('PublicSubnet2')],
        LoadBalancerAttributes: [
          { Key: 'idle_timeout.timeout_seconds', Value: '60' },
          { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
        ],
        Tags: tags(project),
      },
    },
    Listener: {
      Type: 'AWS::ElasticLoadBalancingV2::Listener',
      Properties: {
        LoadBalancerArn: ref('LoadBalancer'),
        Protocol: settings.cloudFront ? 'HTTP' : 'HTTPS',
        Port: settings.cloudFront ? 80 : 443,
        ...(!settings.cloudFront && {
          Certificates: [{ CertificateArn: settings.certificateArn }],
          SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
        }),
        DefaultActions: [
          {
            Type: 'fixed-response',
            FixedResponseConfig: { StatusCode: '503', ContentType: 'text/plain' },
          },
        ],
      },
    },
  };
  for (const index of [1, 2]) {
    const zone = availabilityZones[index - 1];
    resources[`PublicSubnet${String(index)}`] = {
      Type: 'AWS::EC2::Subnet',
      Properties: {
        VpcId: ref('Vpc'),
        AvailabilityZone: zone,
        CidrBlock: `10.42.${String(index - 1)}.0/24`,
        MapPublicIpOnLaunch: false,
        Tags: tags(project),
      },
    };
    resources[`PrivateSubnet${String(index)}`] = {
      Type: 'AWS::EC2::Subnet',
      Properties: {
        VpcId: ref('Vpc'),
        AvailabilityZone: zone,
        CidrBlock: `10.42.${String(index + 15)}.0/24`,
        MapPublicIpOnLaunch: false,
        Tags: tags(project),
      },
    };
    resources[`PublicRouteAssociation${String(index)}`] = {
      Type: 'AWS::EC2::SubnetRouteTableAssociation',
      Properties: {
        SubnetId: ref(`PublicSubnet${String(index)}`),
        RouteTableId: ref('PublicRouteTable'),
      },
    };
    resources[`NatAddress${String(index)}`] = {
      Type: 'AWS::EC2::EIP',
      DependsOn: 'InternetGatewayAttachment',
      Properties: { Domain: 'vpc', Tags: tags(project) },
    };
    resources[`NatGateway${String(index)}`] = {
      Type: 'AWS::EC2::NatGateway',
      DependsOn: 'InternetRoute',
      Properties: {
        AllocationId: attribute(`NatAddress${String(index)}`, 'AllocationId'),
        SubnetId: ref(`PublicSubnet${String(index)}`),
        Tags: tags(project),
      },
    };
    resources[`PrivateRouteTable${String(index)}`] = {
      Type: 'AWS::EC2::RouteTable',
      Properties: { VpcId: ref('Vpc'), Tags: tags(project) },
    };
    resources[`PrivateRoute${String(index)}`] = {
      Type: 'AWS::EC2::Route',
      Properties: {
        RouteTableId: ref(`PrivateRouteTable${String(index)}`),
        DestinationCidrBlock: '0.0.0.0/0',
        NatGatewayId: ref(`NatGateway${String(index)}`),
      },
    };
    resources[`PrivateRouteAssociation${String(index)}`] = {
      Type: 'AWS::EC2::SubnetRouteTableAssociation',
      Properties: {
        SubnetId: ref(`PrivateSubnet${String(index)}`),
        RouteTableId: ref(`PrivateRouteTable${String(index)}`),
      },
    };
  }
  return resources;
}

export function networkOutputs(): Record<string, Record<string, unknown>> {
  return {
    VpcId: output(ref('Vpc')),
    ListenerArn: output(ref('Listener')),
    TaskSubnetIds: output({ 'Fn::Join': [',', [ref('PrivateSubnet1'), ref('PrivateSubnet2')]] }),
    TaskSecurityGroupId: output(ref('TaskSecurityGroup')),
  };
}
