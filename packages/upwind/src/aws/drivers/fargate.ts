import type { AwsComputeDriver } from '../compute.ts';
import {
  runAwsDeploy,
  runAwsDeployments,
  runAwsDestroy,
  runAwsRollback,
} from '../lifecycle/index.ts';

/** Container and ALB details terminate at this adapter, outside the AWS provider contract. */
export const fargateDriver: AwsComputeDriver = {
  compute: 'fargate',
  deploy: runAwsDeploy,
  deployments: runAwsDeployments,
  rollback: runAwsRollback,
  destroy: runAwsDestroy,
};
