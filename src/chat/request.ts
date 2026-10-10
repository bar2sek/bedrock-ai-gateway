/** A validated chat request with defaults applied. */
export interface ChatRequest {
  readonly question: string;
  /** How many Knowledge Base chunks to retrieve and pass to the model. */
  readonly topK: number;
  /** Randomness of token sampling. Low values suit factual, grounded answers. */
  readonly temperature: number;
  /** Nucleus sampling: only consider the smallest set of tokens whose probabilities sum to topP. */
  readonly topP: number;
}

export const LIMITS = {
  maxQuestionLength: 1000,
  topK: { min: 1, max: 10, default: 4 },
  temperature: { min: 0, max: 1, default: 0.2 },
  topP: { min: 0, max: 1, default: 0.9 },
} as const;

/** Thrown for client errors; the handler maps it to HTTP 400. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Parses and validates the raw API Gateway body. API Gateway already enforces
 * the same JSON Schema, but the function must not trust that: it can also be
 * invoked directly, and the schema can drift.
 */
export function parseChatRequest(body: string | null): ChatRequest {
  if (!body) {
    throw new ValidationError('Request body is required.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ValidationError('Request body must be valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError('Request body must be a JSON object.');
  }
  const input = parsed as Record<string, unknown>;

  const question = typeof input.question === 'string' ? input.question.trim() : '';
  if (question === '') {
    throw new ValidationError('"question" must be a non-empty string.');
  }
  if (question.length > LIMITS.maxQuestionLength) {
    throw new ValidationError(`"question" must be at most ${LIMITS.maxQuestionLength} characters.`);
  }

  return {
    question,
    topK: numberInRange(input.topK, 'topK', LIMITS.topK, true),
    temperature: numberInRange(input.temperature, 'temperature', LIMITS.temperature, false),
    topP: numberInRange(input.topP, 'topP', LIMITS.topP, false),
  };
}

function numberInRange(
  value: unknown,
  name: string,
  range: { min: number; max: number; default: number },
  integer: boolean,
): number {
  if (value === undefined) {
    return range.default;
  }
  if (typeof value !== 'number' || Number.isNaN(value) || (integer && !Number.isInteger(value))) {
    throw new ValidationError(`"${name}" must be ${integer ? 'an integer' : 'a number'}.`);
  }
  if (value < range.min || value > range.max) {
    throw new ValidationError(`"${name}" must be between ${range.min} and ${range.max}.`);
  }
  return value;
}
