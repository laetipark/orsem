import { SourceCheckpointEntity } from '@orsem/database';
import type { DataSource } from 'typeorm';
import { MockAgent } from 'undici';
import { loadWorkerConfig } from '../src/config/worker-config';
import {
  connectorFailureMessage,
  SecSubmissionsConnector,
} from '../src/connectors/connector-adapters';
import { GdeltHttpTransport } from '../src/connectors/gdelt-http-transport';
import { createSecFetch } from '../src/connectors/sec-access-policy';

const CIK = '0000123456';
const PATH = `/submissions/CIK${CIK}.json`;
const USER_AGENT = 'Orsem integration-test contact@example.test';

function database() {
  let row: SourceCheckpointEntity | null = null;
  const repository = {
    findOneBy: async () => row,
    findOne: async () => row,
    save: async (value: SourceCheckpointEntity) => (row = value),
    createQueryBuilder() {
      let input: Partial<SourceCheckpointEntity>;
      const query = {
        insert: () => query,
        values: (value: Partial<SourceCheckpointEntity>) => {
          input = value;
          return query;
        },
        orIgnore: () => query,
        execute: async () => {
          row ??= Object.assign(new SourceCheckpointEntity(), { metadataJson: null }, input);
        },
      };
      return query;
    },
  };
  return {
    dataSource: {
      getRepository: () => repository,
      transaction: async <T>(run: (manager: unknown) => Promise<T>) =>
        run({ getRepository: () => repository }),
    } as unknown as DataSource,
    row: () => row,
  };
}

it.each([200, 403])(
  'delivers the configured identity through native fetch and retains SEC %i policy handling',
  async (status) => {
    const mock = new MockAgent();
    // Exercise native fetch header serialization without permitting any real network access.
    mock.disableNetConnect();
    const nativeFetch = globalThis.fetch;
    // Jest's VM and Node's native fetch do not share the global dispatcher symbol.
    // Supply the mock explicitly at the transport boundary so no DNS/socket is attempted.
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
      nativeFetch(input, {
        ...init,
        dispatcher: mock as unknown as RequestInit['dispatcher'],
      }),
    );
    const transport = new GdeltHttpTransport();
    const db = database();
    const config = loadWorkerConfig({ SEC_USER_AGENT: USER_AGENT });
    const secFetch = createSecFetch(db.dataSource, transport.fetch);
    const connector = new SecSubmissionsConnector(config.secUserAgent, secFetch, 1_000);
    const matchingHeaders = jest.fn((headers: Record<string, string>) => {
      return headers['user-agent'] === USER_AGENT && headers.accept === 'application/json';
    });
    mock
      .get('https://data.sec.gov')
      .intercept({ path: PATH, method: 'GET', headers: matchingHeaders })
      .reply(
        status,
        status === 200
          ? {
              cik: CIK,
              name: 'Test issuer',
              filings: {
                recent: { accessionNumber: [], filingDate: [], form: [], primaryDocument: [] },
              },
            }
          : '<title>Your Request Originates from an Undeclared Automated Tool</title>',
      );
    try {
      if (status === 200) {
        await expect(connector.submissions(CIK)).resolves.toEqual([]);
        expect(db.row()?.metadataJson?.retryAt).toBeUndefined();
      } else {
        const error = await connector.submissions(CIK).catch((value: unknown) => value);
        expect(error).toMatchObject({
          httpStatus: 403,
          providerCode: 'SEC_UNDECLARED_AUTOMATION',
          requestAttempted: true,
        });
        expect(connectorFailureMessage(error)).toContain('SEC Webmaster');
        const attemptsBeforeCooldown = matchingHeaders.mock.calls.length;
        await expect(
          new SecSubmissionsConnector(config.secUserAgent, secFetch, 1_000).submissions(CIK),
        ).rejects.toMatchObject({
          httpStatus: 403,
          providerCode: 'SEC_UNDECLARED_AUTOMATION',
          requestAttempted: false,
        });
        expect(matchingHeaders).toHaveBeenCalledTimes(attemptsBeforeCooldown);
        expect(JSON.stringify(db.row())).not.toContain(USER_AGENT);
        expect(JSON.stringify(db.row())).not.toContain('<title>');
      }
      expect(matchingHeaders).toHaveBeenCalled();
      mock.assertNoPendingInterceptors();
    } finally {
      fetchSpy.mockRestore();
      await transport.onModuleDestroy();
      await mock.close();
    }
  },
);
