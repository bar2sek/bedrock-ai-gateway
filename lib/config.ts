import { Node } from 'constructs';

/**
 * Deployment settings, read from the `gateway` block in cdk.json.
 *
 * The Knowledge Base and Guardrail are created by Terraform in a separate
 * repository; this app only consumes their IDs. None of these values are
 * secret — the AWS account ID is never written to source and is resolved
 * from the caller's credentials at deploy time.
 */
export interface GatewayConfig {
  /** AWS region to deploy into. Must match where the KB and Guardrail live. */
  readonly region: string;
  /** Foundation model ID or cross-region inference profile ID (e.g. `us.amazon.nova-lite-v1:0`). */
  readonly modelId: string;
  readonly knowledgeBaseId: string;
  readonly guardrailId: string;
  /** A published, immutable guardrail version (e.g. `1`). Avoid `DRAFT` outside of testing. */
  readonly guardrailVersion: string;
}

const REQUIRED_KEYS = ['region', 'modelId', 'knowledgeBaseId', 'guardrailId', 'guardrailVersion'] as const;

export function loadConfig(node: Node): GatewayConfig {
  const raw: unknown = node.tryGetContext('gateway');
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Missing "gateway" block in cdk.json context.');
  }

  const values = raw as Record<string, unknown>;
  for (const key of REQUIRED_KEYS) {
    const value = values[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`cdk.json context "gateway.${key}" must be a non-empty string.`);
    }
  }

  return values as unknown as GatewayConfig;
}
