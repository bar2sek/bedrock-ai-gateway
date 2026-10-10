#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { BedrockAiGatewayStack } from '../lib/bedrock-ai-gateway-stack';
import { loadConfig } from '../lib/config';

const app = new cdk.App();
const config = loadConfig(app.node);

new BedrockAiGatewayStack(app, 'BedrockAiGateway', {
  // The account comes from the deploying credentials, never from source.
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.region },
  description: 'Bedrock AI gateway: API Gateway + Lambda RAG over a Bedrock Knowledge Base, with Guardrails',
  config,
});

cdk.Tags.of(app).add('project', 'bedrock-ai-gateway');
cdk.Tags.of(app).add('managed-by', 'cdk');
