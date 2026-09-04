import { ConnectorStatus } from '@orsem/contracts';
import { ConnectorHealthEntity, IrSourceEntity } from '@orsem/database';
import type { DataSource } from 'typeorm';
import {
  AI_HEALTH_PROBE_TIMEOUT_MS,
  CompatibleClassifierClient,
  type AiClassifierHealth,
} from '../src/ai/compatible-classifier.client';
import { loadWorkerConfig } from '../src/config/worker-config';
import { ConnectorHealthService } from '../src/connectors/connector-health.service';

const MODEL = 'qwen3.5:4b-q4_K_M';

describe('OpenAI-compatible AI health probe', () => {
  it('lists models without inference and requires the exact configured model', async () => {
    let requestedUrl = '';
    let requestedInit: RequestInit | undefined;
    const timeoutSignal = new AbortController().signal;
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    try {
      const client = new CompatibleClassifierClient(
        loadWorkerConfig({
          AI_ENABLED: 'true',
          AI_MODEL: MODEL,
          AI_BASE_URL: 'http://127.0.0.1:11434/v1',
          AI_API_KEY: 'test-secret',
        }),
        async (input, init) => {
          requestedUrl = new URL(
            input instanceof Request ? input.url : input.toString(),
          ).toString();
          requestedInit = init;
          return new Response(
            JSON.stringify({
              object: 'list',
              data: [{ id: 'another-model' }, { id: MODEL }],
            }),
            { status: 200 },
          );
        },
      );

      await expect(client.probeHealth()).resolves.toMatchObject({
        status: ConnectorStatus.HEALTHY,
        message: null,
        enabled: true,
        configuredModelPresent: true,
      });
      expect(requestedUrl).toBe('http://127.0.0.1:11434/v1/models');
      expect(requestedInit?.method).toBe('GET');
      expect(requestedInit?.body).toBeUndefined();
      expect(new Headers(requestedInit?.headers).get('authorization')).toBe('Bearer test-secret');
      expect(timeoutSpy).toHaveBeenCalledWith(AI_HEALTH_PROBE_TIMEOUT_MS);
      expect(requestedInit?.signal).toBe(timeoutSignal);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('does not call an endpoint while the classifier is disabled', async () => {
    const fetcher = jest.fn();
    const client = new CompatibleClassifierClient(
      loadWorkerConfig({ AI_ENABLED: 'false', AI_MODEL: MODEL }),
      fetcher,
    );

    await expect(client.probeHealth()).resolves.toMatchObject({
      status: ConnectorStatus.UNCONFIGURED,
      enabled: false,
      configuredModelPresent: null,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'non-2xx response',
      fetcher: async () => new Response('', { status: 503 }),
      expectedMessage: 'AI model probe returned HTTP 503.',
      expectedPresence: null,
    },
    {
      label: 'missing configured model',
      fetcher: async () =>
        new Response(JSON.stringify({ data: [{ id: 'another-model' }] }), { status: 200 }),
      expectedMessage: 'Configured AI model is not available from the endpoint.',
      expectedPresence: false,
    },
    {
      label: 'timeout',
      fetcher: async () => {
        throw Object.assign(new Error('http://secret.internal key=leak-me'), {
          name: 'TimeoutError',
        });
      },
      expectedMessage: 'AI model probe timed out.',
      expectedPresence: null,
    },
  ])('returns a sanitized DEGRADED result for $label', async (scenario) => {
    const client = new CompatibleClassifierClient(
      loadWorkerConfig({
        AI_ENABLED: 'true',
        AI_MODEL: MODEL,
        AI_BASE_URL: 'http://127.0.0.1:11434/v1',
        AI_API_KEY: 'leak-me',
      }),
      scenario.fetcher,
    );

    const result = await client.probeHealth();

    expect(result).toMatchObject({
      status: ConnectorStatus.DEGRADED,
      message: scenario.expectedMessage,
      enabled: true,
      configuredModelPresent: scenario.expectedPresence,
    });
    expect(JSON.stringify(result)).not.toContain('127.0.0.1');
    expect(JSON.stringify(result)).not.toContain('leak-me');
  });
});

describe('AI connector health persistence', () => {
  it('stores connector=ai and preserves lastSuccessAt when a later probe degrades', async () => {
    const priorSuccess = new Date('2026-09-03T00:00:00.000Z');
    const checkedAt = new Date('2026-09-03T01:00:00.000Z');
    const rows = new Map<string, ConnectorHealthEntity>();
    rows.set('ai', {
      id: '00000000-0000-4000-8000-000000000201',
      createdAt: priorSuccess,
      updatedAt: priorSuccess,
      connector: 'ai',
      status: ConnectorStatus.HEALTHY,
      message: null,
      lastSuccessAt: priorSuccess,
      lastFailureAt: null,
      checkedAt: priorSuccess,
      metadataJson: null,
    });
    const healthRepository = {
      findOne: jest
        .fn()
        .mockImplementation(async (query: { where: { connector: string } }) =>
          rows.get(query.where.connector),
        ),
      create: jest.fn().mockImplementation((value: { connector: string }) => ({ ...value })),
      save: jest.fn().mockImplementation(async (value: ConnectorHealthEntity) => {
        value.lastSuccessAt ??= null;
        value.lastFailureAt ??= null;
        rows.set(value.connector, value);
        return value;
      }),
    };
    const repositoryFor = (target: unknown): unknown => {
      if (target === IrSourceEntity) return { find: jest.fn().mockResolvedValue([]) };
      if (target === ConnectorHealthEntity) return healthRepository;
      throw new Error('Unexpected repository target in AI health test.');
    };
    const dataSource = { getRepository: repositoryFor } as unknown as DataSource;
    const config = loadWorkerConfig({
      AI_ENABLED: 'true',
      AI_MODEL: MODEL,
      AI_BASE_URL: 'http://127.0.0.1:11434/v1',
      AI_API_KEY: 'never-persist-this',
      GDELT_ENABLED: 'false',
    });
    const classifier = {
      probeHealth: jest.fn().mockResolvedValue({
        status: ConnectorStatus.DEGRADED,
        message: 'Configured AI model is not available from the endpoint.',
        checkedAt,
        enabled: true,
        configuredModelPresent: false,
      } satisfies AiClassifierHealth),
    } as unknown as CompatibleClassifierClient;
    const service = new ConnectorHealthService(
      dataSource,
      config,
      async () => {
        throw new Error('No network adapter should be probed in this fixture.');
      },
      classifier,
    );

    const checks = await service.checkAll();
    const aiCheck = checks.find((check) => check.connector === 'AI');
    const persisted = rows.get('ai');

    expect(aiCheck).toMatchObject({
      connector: 'AI',
      status: ConnectorStatus.DEGRADED,
      message: 'Configured AI model is not available from the endpoint.',
    });
    expect(persisted).toMatchObject({
      connector: 'ai',
      status: ConnectorStatus.DEGRADED,
      lastSuccessAt: priorSuccess,
      lastFailureAt: checkedAt,
      checkedAt,
      metadataJson: {
        healthSource: 'OPENAI_COMPATIBLE_MODELS',
        enabled: true,
        configuredModelPresent: false,
      },
    });
    expect(JSON.stringify(persisted)).not.toContain('127.0.0.1');
    expect(JSON.stringify(persisted)).not.toContain('never-persist-this');
  });
});
