export interface GatewayEnv {
  readonly modelId: string;
  readonly knowledgeBaseId: string;
  readonly guardrailId: string;
  readonly guardrailVersion: string;
  /** DynamoDB table that receives one usage record per answered request. */
  readonly usageTableName: string;
}

/** Reads the function's configuration, failing loudly if the stack forgot a variable. */
export function loadEnv(env: NodeJS.ProcessEnv): GatewayEnv {
  return {
    modelId: required(env, 'MODEL_ID'),
    knowledgeBaseId: required(env, 'KNOWLEDGE_BASE_ID'),
    guardrailId: required(env, 'GUARDRAIL_ID'),
    guardrailVersion: required(env, 'GUARDRAIL_VERSION'),
    usageTableName: required(env, 'USAGE_TABLE_NAME'),
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is not set.`);
  }
  return value;
}
