import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';

const INFERENCE_PROFILE_PREFIX = /^(us|eu|apac|global)\./;

/**
 * Least-privilege statements for calling a Bedrock model.
 *
 * A cross-region inference profile (`us.` prefix) routes each request to
 * whichever US region has capacity, so the caller needs InvokeModel on the
 * profile *and* on the underlying foundation model in every region it may
 * route to. The condition key limits the foundation-model grant to calls made
 * through this profile, so the function cannot invoke the model directly.
 */
export function modelInvokeStatements(stack: cdk.Stack, modelId: string): iam.PolicyStatement[] {
  if (!INFERENCE_PROFILE_PREFIX.test(modelId)) {
    return [
      new iam.PolicyStatement({
        sid: 'InvokeFoundationModel',
        actions: ['bedrock:InvokeModel'],
        resources: [foundationModelArn(stack, stack.region, modelId)],
      }),
    ];
  }

  const profileArn = stack.formatArn({
    service: 'bedrock',
    resource: 'inference-profile',
    resourceName: modelId,
  });

  return [
    new iam.PolicyStatement({
      sid: 'InvokeInferenceProfile',
      actions: ['bedrock:InvokeModel'],
      resources: [profileArn],
    }),
    new iam.PolicyStatement({
      sid: 'InvokeModelViaInferenceProfile',
      actions: ['bedrock:InvokeModel'],
      resources: [foundationModelArn(stack, '*', modelId.replace(INFERENCE_PROFILE_PREFIX, ''))],
      conditions: { StringEquals: { 'bedrock:InferenceProfileArn': profileArn } },
    }),
  ];
}

// Foundation-model ARNs are AWS-owned, so the account field is empty.
function foundationModelArn(stack: cdk.Stack, region: string, foundationModelId: string): string {
  return stack.formatArn({
    service: 'bedrock',
    region,
    account: '',
    resource: 'foundation-model',
    resourceName: foundationModelId,
  });
}
