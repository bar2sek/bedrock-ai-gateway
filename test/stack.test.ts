import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BedrockAiGatewayStack } from '../lib/bedrock-ai-gateway-stack';

// Synthesizes the stack in memory and asserts on the CloudFormation template —
// no AWS account involved. Fixed test IDs keep the template deterministic.
const app = new cdk.App();
const stack = new BedrockAiGatewayStack(app, 'TestStack', {
  env: { account: '111111111111', region: 'us-east-2' },
  config: {
    region: 'us-east-2',
    modelId: 'us.amazon.nova-lite-v1:0',
    knowledgeBaseId: 'KB123',
    guardrailId: 'gr-123',
    guardrailVersion: '1',
  },
});
const template = Template.fromStack(stack);

// CDK leaves the partition (aws, aws-cn, aws-us-gov) to CloudFormation, so
// ARNs synthesize as a join with a reference to AWS::Partition.
const arn = (rest: string) => ({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, rest]] });

test('chat function runs Node.js 24 on Graviton with tracing', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs24.x',
    Architectures: ['arm64'],
    TracingConfig: { Mode: 'Active' },
    Environment: {
      Variables: Match.objectLike({
        KNOWLEDGE_BASE_ID: 'KB123',
        GUARDRAIL_VERSION: '1',
        POWERTOOLS_METRICS_NAMESPACE: 'BedrockAiGateway',
      }),
    },
  });
});

test('POST /chat requires an API key', () => {
  template.hasResourceProperties('AWS::ApiGateway::Method', {
    HttpMethod: 'POST',
    ApiKeyRequired: true,
  });
});

test('usage plan caps each consumer', () => {
  template.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
    Throttle: { RateLimit: 1, BurstLimit: 5 },
    Quota: { Limit: 500, Period: 'DAY' },
  });
});

test('foundation-model access is only allowed through the inference profile', () => {
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Sid: 'InvokeModelViaInferenceProfile',
          Resource: arn(':bedrock:*::foundation-model/amazon.nova-lite-v1:0'),
          Condition: {
            StringEquals: {
              'bedrock:InferenceProfileArn': arn(':bedrock:us-east-2:111111111111:inference-profile/us.amazon.nova-lite-v1:0'),
            },
          },
        }),
      ]),
    },
  });
});

test('no IAM statement grants wildcard actions', () => {
  const policies = template.findResources('AWS::IAM::Policy');
  const actions = Object.values(policies).flatMap((policy) =>
    policy.Properties.PolicyDocument.Statement.flatMap((statement: { Action: string | string[] }) =>
      [statement.Action].flat(),
    ),
  );
  expect(actions.some((action) => action.endsWith('*'))).toBe(false);
});
