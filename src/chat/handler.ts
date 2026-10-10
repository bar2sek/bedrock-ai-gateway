import { Logger } from '@aws-lambda-powertools/logger';
import { BedrockAgentRuntimeClient, RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { loadEnv } from './env';
import { buildConverseInput, NO_CONTEXT_ANSWER, toSources, type Source } from './rag';
import { parseChatRequest, ValidationError } from './request';

const logger = new Logger();

// Created once per execution environment, outside the handler, so warm
// invocations reuse the clients and their open connections.
const agentRuntime = new BedrockAgentRuntimeClient({});
const bedrock = new BedrockRuntimeClient({});

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
      return json(200, response(NO_CONTEXT_ANSWER, [], false, 0, 0, env.modelId, startedAt));
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
    return json(
      200,
      response(answer, guardrailIntervened ? [] : sources, guardrailIntervened, inputTokens, outputTokens, env.modelId, startedAt),
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      return json(400, { error: error.message });
    }
    if (error instanceof Error && error.name === 'ThrottlingException') {
      logger.warn('Bedrock throttled the request', { error });
      return json(429, { error: 'The model is busy. Please retry shortly.' });
    }
    // Log the details, return a generic message: internal errors can leak ARNs or account IDs.
    logger.error('Chat request failed', { error });
    return json(502, { error: 'The assistant is unavailable. Please try again later.' });
  }
};

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
