import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { modelInvokeStatements } from './bedrock-permissions';
import { GatewayConfig } from './config';

/** CloudWatch namespace for the chat function's custom (EMF) metrics. */
export const METRICS_NAMESPACE = 'BedrockAiGateway';

export interface BedrockAiGatewayStackProps extends cdk.StackProps {
  readonly config: GatewayConfig;
}

/**
 * API Gateway → Lambda → Bedrock (Knowledge Base retrieval + guarded generation).
 *
 * API Gateway owns consumer identity and rate limiting (API keys + usage plan)
 * and rejects malformed requests before they cost a Lambda invocation. The
 * Lambda owns the RAG flow and is the only principal allowed to call Bedrock.
 */
export class BedrockAiGatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BedrockAiGatewayStackProps) {
    super(scope, id, props);
    const { config } = props;

    // --- Chat function ------------------------------------------------------
    // NodejsFunction bundles src/chat/handler.ts and its dependencies with
    // esbuild at synth time, so only the code the handler imports is shipped.
    const chatFunction = new nodejs.NodejsFunction(this, 'ChatFunction', {
      entry: path.join(__dirname, '..', 'src', 'chat', 'handler.ts'),
      description: 'RAG chat: Bedrock Knowledge Base retrieval + Converse with Guardrails',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      // API Gateway REST integrations time out at 29 seconds.
      timeout: cdk.Duration.seconds(29),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: new logs.LogGroup(this, 'ChatFunctionLogs', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        MODEL_ID: config.modelId,
        KNOWLEDGE_BASE_ID: config.knowledgeBaseId,
        GUARDRAIL_ID: config.guardrailId,
        GUARDRAIL_VERSION: config.guardrailVersion,
        POWERTOOLS_SERVICE_NAME: 'ai-gateway',
        POWERTOOLS_METRICS_NAMESPACE: METRICS_NAMESPACE,
        POWERTOOLS_LOG_LEVEL: 'INFO',
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node24',
      },
    });

    // --- Bedrock permissions (least privilege) -------------------------------
    for (const statement of modelInvokeStatements(this, config.modelId)) {
      chatFunction.addToRolePolicy(statement);
    }
    chatFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'RetrieveFromKnowledgeBase',
        actions: ['bedrock:Retrieve'],
        resources: [
          this.formatArn({ service: 'bedrock', resource: 'knowledge-base', resourceName: config.knowledgeBaseId }),
        ],
      }),
    );
    // Converse evaluates the guardrail on the caller's behalf, so the caller
    // needs ApplyGuardrail on it.
    chatFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ApplyGuardrail',
        actions: ['bedrock:ApplyGuardrail'],
        resources: [this.formatArn({ service: 'bedrock', resource: 'guardrail', resourceName: config.guardrailId })],
      }),
    );

    // --- API Gateway ---------------------------------------------------------
    const api = new apigw.RestApi(this, 'GatewayApi', {
      restApiName: 'bedrock-ai-gateway',
      description: 'Governed entry point to Bedrock-backed knowledge assistants',
      endpointTypes: [apigw.EndpointType.REGIONAL],
      deployOptions: {
        stageName: 'v1',
        tracingEnabled: true,
        // Stage-wide ceiling; per-consumer limits live on the usage plan.
        throttlingRateLimit: 5,
        throttlingBurstLimit: 10,
      },
    });

    // JSON Schema validation at the edge. The Lambda validates again (defence
    // in depth), but bad requests stop here without invoking it.
    const chatRequestModel = api.addModel('ChatRequest', {
      contentType: 'application/json',
      schema: {
        schema: apigw.JsonSchemaVersion.DRAFT4,
        type: apigw.JsonSchemaType.OBJECT,
        required: ['question'],
        additionalProperties: false,
        properties: {
          question: { type: apigw.JsonSchemaType.STRING, minLength: 1, maxLength: 1000 },
          topK: { type: apigw.JsonSchemaType.INTEGER, minimum: 1, maximum: 10 },
          temperature: { type: apigw.JsonSchemaType.NUMBER, minimum: 0, maximum: 1 },
          topP: { type: apigw.JsonSchemaType.NUMBER, minimum: 0, maximum: 1 },
        },
      },
    });

    api.root.addResource('chat').addMethod('POST', new apigw.LambdaIntegration(chatFunction), {
      apiKeyRequired: true,
      requestModels: { 'application/json': chatRequestModel },
      requestValidator: api.addRequestValidator('BodyValidator', { validateRequestBody: true }),
    });

    // Each downstream consumer gets its own API key; the usage plan caps how
    // fast and how much each key can call, which also caps Bedrock spend.
    const usagePlan = api.addUsagePlan('DefaultUsagePlan', {
      name: 'default',
      throttle: { rateLimit: 1, burstLimit: 5 },
      quota: { limit: 500, period: apigw.Period.DAY },
    });
    usagePlan.addApiStage({ stage: api.deploymentStage });
    const demoKey = api.addApiKey('DemoConsumerKey', { apiKeyName: 'demo-consumer' });
    usagePlan.addApiKey(demoKey);

    // --- Outputs -------------------------------------------------------------
    new cdk.CfnOutput(this, 'ChatEndpoint', { value: api.urlForPath('/chat') });
    new cdk.CfnOutput(this, 'DemoApiKeyId', {
      value: demoKey.keyId,
      description: 'Fetch the key value with: aws apigateway get-api-key --include-value --api-key <id>',
    });
    new cdk.CfnOutput(this, 'ChatFunctionName', { value: chatFunction.functionName });
  }
}
