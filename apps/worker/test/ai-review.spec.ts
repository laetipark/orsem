import { Direction, TransactionNature } from '@orsem/contracts';
import {
  AI_CLASSIFIER_OUTPUT_JSON_SCHEMA,
  AI_CLASSIFIER_PROMPT_HASH,
  AI_CLASSIFIER_PROMPT_VERSION,
  AI_CLASSIFIER_SYSTEM_PROMPT,
  CompatibleClassifierClient,
  reviewAiSuggestion,
} from '../src/ai/compatible-classifier.client';
import { loadWorkerConfig } from '../src/config/worker-config';

describe('AI classification safety review', () => {
  it('rejects an AI-only market-buy upgrade', () => {
    const review = reviewAiSuggestion({
      output: {
        nature: TransactionNature.MARKET_BUY,
        direction: Direction.INCREASE,
        confidence: 0.99,
        rationale: '양수 수량',
        evidence: ['기타 증가'],
      },
      sourceFragments: ['기타 증가', '보통주'],
      deterministicNature: TransactionNature.UNKNOWN,
      deterministicDirection: Direction.INCREASE,
    });
    expect(review.result).toBe('REVIEW_REQUIRED');
    expect(review.reasons).toContain(
      'AI cannot upgrade an unknown method into a market transaction.',
    );
  });

  it('rejects hallucinated evidence', () => {
    const review = reviewAiSuggestion({
      output: {
        nature: TransactionNature.OTHER,
        direction: Direction.INCREASE,
        confidence: 0.95,
        rationale: '기타',
        evidence: ['원문에 없는 문장'],
      },
      sourceFragments: ['기타 증가'],
      deterministicNature: TransactionNature.UNKNOWN,
      deterministicDirection: Direction.INCREASE,
    });
    expect(review.result).toBe('REVIEW_REQUIRED');
  });

  it('rejects a confident suggestion without source evidence', () => {
    const review = reviewAiSuggestion({
      output: {
        nature: TransactionNature.OTHER,
        direction: Direction.INCREASE,
        confidence: 0.99,
        rationale: '근거 없는 제안',
        evidence: [],
      },
      sourceFragments: ['기타 증가', '보통주'],
      deterministicNature: TransactionNature.UNKNOWN,
      deterministicDirection: Direction.INCREASE,
    });
    expect(review.result).toBe('REVIEW_REQUIRED');
    expect(review.reasons).toContain('AI did not cite any source evidence.');
  });

  it('requires each evidence item to come from one source fragment', () => {
    const review = reviewAiSuggestion({
      output: {
        nature: TransactionNature.OTHER,
        direction: Direction.INCREASE,
        confidence: 0.95,
        rationale: '조각 경계를 넘은 증거',
        evidence: ['기타 증가\n보통주'],
      },
      sourceFragments: ['기타 증가', '보통주'],
      deterministicNature: TransactionNature.UNKNOWN,
      deterministicDirection: Direction.INCREASE,
    });
    expect(review.result).toBe('REVIEW_REQUIRED');
    expect(review.reasons).toContain(
      'AI evidence is not a verbatim fragment of the supplied source.',
    );
  });

  it('confirms only when both resolved fields exactly match the deterministic result', () => {
    const review = reviewAiSuggestion({
      output: {
        nature: TransactionNature.OTHER,
        direction: Direction.INCREASE,
        confidence: 0.99,
        rationale: '결정론 결과 확인',
        evidence: ['기타 증가'],
      },
      sourceFragments: ['기타 증가', '보통주'],
      deterministicNature: TransactionNature.OTHER,
      deterministicDirection: Direction.INCREASE,
    });

    expect(review.result).toBe('AI_CONFIRMED');
  });

  it('marks a safely resolved deterministic unknown as an AI suggestion', () => {
    const review = reviewAiSuggestion({
      output: {
        nature: TransactionNature.OTHER,
        direction: Direction.INCREASE,
        confidence: 0.99,
        rationale: '원문의 기타 증가 문구',
        evidence: ['기타 증가'],
      },
      sourceFragments: ['기타 증가', '보통주'],
      deterministicNature: TransactionNature.UNKNOWN,
      deterministicDirection: Direction.INCREASE,
    });

    expect(review.result).toBe('AI_SUGGESTED');
  });

  it.each([
    {
      nature: TransactionNature.UNKNOWN,
      direction: Direction.INCREASE,
      deterministicNature: TransactionNature.UNKNOWN,
      deterministicDirection: Direction.INCREASE,
    },
    {
      nature: TransactionNature.OTHER,
      direction: Direction.UNKNOWN,
      deterministicNature: TransactionNature.OTHER,
      deterministicDirection: Direction.UNKNOWN,
    },
  ])('requires review when the AI leaves either output field unknown', (classification) => {
    const review = reviewAiSuggestion({
      output: {
        nature: classification.nature,
        direction: classification.direction,
        confidence: 0.99,
        rationale: '분류 불충분',
        evidence: ['기타 증가'],
      },
      sourceFragments: ['기타 증가', '보통주'],
      deterministicNature: classification.deterministicNature,
      deterministicDirection: classification.deterministicDirection,
    });

    expect(review.result).toBe('REVIEW_REQUIRED');
    expect(review.reasons).toContain('AI output must resolve both nature and direction.');
  });

  it('sends an Ollama-compatible strict JSON schema request without requiring an API key', async () => {
    let requestedUrl = '';
    let requestedInit: RequestInit | undefined;
    const timeoutSignal = new AbortController().signal;
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    const client = new CompatibleClassifierClient(
      loadWorkerConfig({
        AI_ENABLED: 'true',
        AI_MODEL: 'qwen3.5:4b-q4_K_M',
        AI_BASE_URL: 'http://127.0.0.1:11434/v1',
        AI_TIMEOUT_MS: '180000',
      }),
      async (input, init) => {
        requestedUrl = new URL(input instanceof Request ? input.url : input.toString()).toString();
        requestedInit = init;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    nature: TransactionNature.OTHER,
                    direction: Direction.INCREASE,
                    confidence: 0.95,
                    rationale: '기타 증가로 기재됨',
                    evidence: ['기타 증가'],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    );

    const review = await client.suggest({
      methodRaw: '기타 증가',
      securityTypeRaw: '보통주',
      quantity: '100',
      deterministicNature: TransactionNature.UNKNOWN,
      deterministicDirection: Direction.INCREASE,
    });

    expect(requestedUrl).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(timeoutSpy).toHaveBeenCalledWith(180_000);
    expect(requestedInit?.signal).toBe(timeoutSignal);
    expect(new Headers(requestedInit?.headers).has('authorization')).toBe(false);
    const body = JSON.parse(String(requestedInit?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'qwen3.5:4b-q4_K_M',
      temperature: 0,
      reasoning_effort: 'none',
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'orsem_transaction_classification_review',
          strict: true,
          schema: AI_CLASSIFIER_OUTPUT_JSON_SCHEMA,
        },
      },
      messages: [{ role: 'system', content: AI_CLASSIFIER_SYSTEM_PROMPT }, { role: 'user' }],
    });
    expect(review.result).toBe('AI_SUGGESTED');
    expect(review.audit).toMatchObject({
      promptHash: AI_CLASSIFIER_PROMPT_HASH,
      promptVersion: AI_CLASSIFIER_PROMPT_VERSION,
    });
    timeoutSpy.mockRestore();
  });

  it('uses a CPU-safe AI timeout default and rejects excessive values', () => {
    expect(loadWorkerConfig({}).aiTimeoutMs).toBe(120_000);
    expect(loadWorkerConfig({ AI_TIMEOUT_MS: '600000' }).aiTimeoutMs).toBe(600_000);
    expect(() => loadWorkerConfig({ AI_TIMEOUT_MS: '600001' })).toThrow();
  });

  it('degrades invalid endpoint JSON into an auditable review result', async () => {
    const client = new CompatibleClassifierClient(
      loadWorkerConfig({
        AI_ENABLED: 'true',
        AI_MODEL: 'local-test',
        AI_BASE_URL: 'http://127.0.0.1:11434/v1',
      }),
      async () => new Response('{invalid', { status: 200 }),
    );
    const review = await client.suggest({
      methodRaw: '기타 증가',
      securityTypeRaw: '보통주',
      quantity: '100',
      deterministicNature: TransactionNature.UNKNOWN,
      deterministicDirection: Direction.INCREASE,
    });
    expect(review.result).toBe('REVIEW_REQUIRED');
    expect(review.audit).toMatchObject({
      model: 'local-test',
      promptHash: AI_CLASSIFIER_PROMPT_HASH,
      promptVersion: 'transaction-review-v2',
    });
    expect(review.audit?.inputHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
