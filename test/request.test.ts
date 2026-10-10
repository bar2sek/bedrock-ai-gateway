import { LIMITS, parseChatRequest, ValidationError } from '../src/chat/request';

describe('parseChatRequest', () => {
  test('applies defaults when only a question is given', () => {
    expect(parseChatRequest(JSON.stringify({ question: '  How much PTO do I get?  ' }))).toEqual({
      question: 'How much PTO do I get?',
      topK: LIMITS.topK.default,
      temperature: LIMITS.temperature.default,
      topP: LIMITS.topP.default,
    });
  });

  test('accepts explicit sampling settings', () => {
    const request = parseChatRequest(JSON.stringify({ question: 'q', topK: 8, temperature: 0, topP: 0.5 }));
    expect(request).toMatchObject({ topK: 8, temperature: 0, topP: 0.5 });
  });

  test.each([
    ['missing body', null, 'Request body is required.'],
    ['invalid JSON', '{not json', 'Request body must be valid JSON.'],
    ['JSON array', '[]', 'Request body must be a JSON object.'],
    ['empty question', JSON.stringify({ question: '   ' }), '"question" must be a non-empty string.'],
    ['non-integer topK', JSON.stringify({ question: 'q', topK: 2.5 }), '"topK" must be an integer.'],
    ['topK out of range', JSON.stringify({ question: 'q', topK: 50 }), '"topK" must be between 1 and 10.'],
    ['temperature as string', JSON.stringify({ question: 'q', temperature: '0.5' }), '"temperature" must be a number.'],
  ])('rejects %s', (_case, body, message) => {
    expect(() => parseChatRequest(body)).toThrow(new ValidationError(message));
  });

  test('rejects questions over the length limit', () => {
    const body = JSON.stringify({ question: 'x'.repeat(LIMITS.maxQuestionLength + 1) });
    expect(() => parseChatRequest(body)).toThrow(ValidationError);
  });
});
