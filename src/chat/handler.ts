import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { BedrockAgentRuntimeClient, RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { loadEnv } from './env';
import { buildConverseInput, NO_CONTEXT_ANSWER, toSources, type Source } from './rag';
import { parseChatRequest, ValidationError } from './request';

const logger = new Logger();
// Namespace and service come from POWERTOOLS_METRICS_NAMESPACE and
// POWERTOOLS_SERVICE_NAME (set by the stack). Metrics are written as Embedded
// Metric Format (EMF) log lines; CloudWatch extracts them from the log group,
// so publishing needs no extra API call and no extra IAM permission.
const metrics = new Metrics();

// Created once per execution environment, outside the handler, so warm
// invocations reuse the clients and their open connections.
const agentRuntime = new BedrockAgentRuntimeClient({});
const bedrock = new BedrockRuntimeClient({});
const dynamodb = new DynamoDBClient({});

/** Usage records expire (DynamoDB TTL) after this long. */
const USAGE_RETENTION_SECONDS = 90 * 24 * 60 * 60;

type UsageOutcome = 'answered' | 'blocked' | 'no_context';

export interface ChatResponse {
  readonly answer: string;
  readonly sources: Source[];
  readonly guardrailIntervened: boolean;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly modelId: string;
  readonly latencyMs: number;
}

export const handler = async (event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);
  // Emitted once per execution environment: shows how often users hit a cold start.
  metrics.captureColdStartMetric();
  const startedAt = Date.now();

  try {
    const env = loadEnv(process.env);
    const request = parseChatRequest(event.body);

    // 1. Retrieve: embed the question and find the closest chunks in the vector store.
    const retrieval = await agentRuntime.send(
      new RetrieveCommand({
        knowledgeBaseId: env.knowledgeBaseId,
        retrievalQuery: { text: request.question },
        retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: request.topK } },
      }),
    );
    const sources = toSources(retrieval.retrievalResults ?? []);

    // Nothing to ground on: answer directly instead of letting the model guess.
    if (sources.length === 0) {
      logger.info('No sources retrieved', { topK: request.topK });
      metrics.addMetric('NoContextAnswers', MetricUnit.Count, 1);
      metrics.addMetric('Latency', MetricUnit.Milliseconds, Date.now() - startedAt);
      const result = response(NO_CONTEXT_ANSWER, [], false, 0, 0, env.modelId, startedAt);
      await recordUsage(env.usageTableName, event, context, result, 'no_context');
      return json(200, result);
    }

    // 2. Generate: answer from the sources, with the guardrail screening input and output.
    const output = await bedrock.send(
      new ConverseCommand(
        buildConverseInput({
          modelId: env.modelId,
          guardrailId: env.guardrailId,
          guardrailVersion: env.guardrailVersion,
          question: request.question,
          sources,
          temperature: request.temperature,
          topP: request.topP,
        }),
      ),
    );

    const answer = (output.output?.message?.content ?? []).map((block) => block.text ?? '').join('');
    const guardrailIntervened = output.stopReason === 'guardrail_intervened';
    const inputTokens = output.usage?.inputTokens ?? 0;
    const outputTokens = output.usage?.outputTokens ?? 0;

    metrics.addMetric('InputTokens', MetricUnit.Count, inputTokens);
    metrics.addMetric('OutputTokens', MetricUnit.Count, outputTokens);
    // 0 or 1 per request, so Sum is the count and Average is the intervention rate.
    metrics.addMetric('GuardrailInterventions', MetricUnit.Count, guardrailIntervened ? 1 : 0);
    metrics.addMetric('Latency', MetricUnit.Milliseconds, Date.now() - startedAt);

    logger.info('Chat completed', {
      topK: request.topK,
      sourceCount: sources.length,
      guardrailIntervened,
      stopReason: output.stopReason,
      inputTokens,
      outputTokens,
    });

    // When the guardrail blocks, the answer is its canned message and the
    // sources no longer support it, so they are withheld.
    const result = response(
      answer,
      guardrailIntervened ? [] : sources,
      guardrailIntervened,
      inputTokens,
      outputTokens,
      env.modelId,
      startedAt,
    );
    await recordUsage(env.usageTableName, event, context, result, guardrailIntervened ? 'blocked' : 'answered');
    return json(200, result);
  } catch (error) {
    if (error instanceof ValidationError) {
      return json(400, { error: error.message });
    }
    if (error instanceof Error && error.name === 'ThrottlingException') {
      logger.warn('Bedrock throttled the request', { error });
      metrics.addMetric('BedrockThrottles', MetricUnit.Count, 1);
      return json(429, { error: 'The model is busy. Please retry shortly.' });
    }
    // Log the details, return a generic message: internal errors can leak ARNs or account IDs.
    logger.error('Chat request failed', { error });
    // The handler catches every error, so Lambda's own Errors metric stays at 0.
    // This metric (and API Gateway's 5XXError) is what reveals failures.
    metrics.addMetric('ServerErrors', MetricUnit.Count, 1);
    return json(502, { error: 'The assistant is unavailable. Please try again later.' });
  } finally {
    // Validation failures (400) record no metrics; API Gateway's 4XXError covers them.
    if (metrics.hasStoredMetrics()) {
      metrics.publishStoredMetrics();
    }
  }
};

/**
 * Writes one usage record per answered request, keyed by the caller's API key
 * (one key per consumer), so usage and cost can be reported per consumer.
 * Never fails the request: a write error is logged and counted instead.
 */
async function recordUsage(
  tableName: string,
  event: APIGatewayProxyEvent,
  context: Context,
  result: ChatResponse,
  outcome: UsageOutcome,
): Promise<void> {
  const now = new Date();
  try {
    await dynamodb.send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          consumer: { S: event.requestContext?.identity?.apiKeyId ?? 'unknown' },
          // Sorts chronologically; the request ID keeps simultaneous requests distinct.
          requestedAt: { S: `${now.toISOString()}#${context.awsRequestId}` },
          outcome: { S: outcome },
          modelId: { S: result.modelId },
          inputTokens: { N: String(result.usage.inputTokens) },
          outputTokens: { N: String(result.usage.outputTokens) },
          latencyMs: { N: String(result.latencyMs) },
          expiresAt: { N: String(Math.floor(now.getTime() / 1000) + USAGE_RETENTION_SECONDS) },
        },
      }),
    );
  } catch (error) {
    logger.warn('Usage record write failed', { error });
    metrics.addMetric('UsageLogFailures', MetricUnit.Count, 1);
  }
}

function response(
  answer: string,
  sources: Source[],
  guardrailIntervened: boolean,
  inputTokens: number,
  outputTokens: number,
  modelId: string,
  startedAt: number,
): ChatResponse {
  return {
    answer,
    sources,
    guardrailIntervened,
    usage: { inputTokens, outputTokens },
    modelId,
    latencyMs: Date.now() - startedAt,
  };
}

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
