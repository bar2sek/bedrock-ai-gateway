import { buildConverseInput, formatSources, SYSTEM_PROMPT, toSources } from '../src/chat/rag';

describe('toSources', () => {
  test('numbers retrieved chunks from 1 and drops empty ones', () => {
    const sources = toSources([
      { content: { text: 'PTO accrues monthly.' }, location: { type: 'S3', s3Location: { uri: 's3://corpus/pto.md' } }, score: 0.8 },
      { content: { text: '' } },
      { content: { text: 'Remote work needs approval.' }, score: 0.6 },
    ]);

    expect(sources).toEqual([
      { id: 1, text: 'PTO accrues monthly.', location: 's3://corpus/pto.md', score: 0.8 },
      { id: 2, text: 'Remote work needs approval.', location: undefined, score: 0.6 },
    ]);
  });
});

describe('buildConverseInput', () => {
  const sources = [{ id: 1, text: 'Expense reports are due within 30 days.' }];
  const input = buildConverseInput({
    modelId: 'us.amazon.nova-lite-v1:0',
    guardrailId: 'gr-123',
    guardrailVersion: '1',
    question: 'When are expense reports due?',
    sources,
    temperature: 0.2,
    topP: 0.9,
  });

  test('keeps instructions in the system prompt, not the user turn', () => {
    expect(input.system).toEqual([{ text: SYSTEM_PROMPT }]);
  });

  test('tags sources and question for the guardrail grounding check', () => {
    expect(input.messages?.[0].content).toEqual([
      { guardContent: { text: { text: `Sources:\n\n${formatSources(sources)}`, qualifiers: ['grounding_source'] } } },
      { guardContent: { text: { text: 'When are expense reports due?', qualifiers: ['query', 'guard_content'] } } },
    ]);
  });

  test('passes sampling settings and the guardrail through', () => {
    expect(input.inferenceConfig).toMatchObject({ temperature: 0.2, topP: 0.9 });
    expect(input.guardrailConfig).toEqual({ guardrailIdentifier: 'gr-123', guardrailVersion: '1', trace: 'enabled' });
  });
});
