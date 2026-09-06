import { randomUUID } from 'node:crypto';
import { SourceCheckpointEntity } from '@orsem/database';
import type { DataSource } from 'typeorm';
import type { ConnectorName, DiscoveryCandidate } from './connector-adapters';

export interface RecoveryState {
  revision: number;
  metadata: Record<string, unknown>;
}
export interface RecoveryStore {
  load(connector: ConnectorName, stream: string): Promise<RecoveryState>;
  commit(
    connector: ConnectorName,
    stream: string,
    expected: number,
    metadata: Record<string, unknown>,
  ): Promise<void>;
}
export interface DiscoveryBatch {
  candidates: readonly DiscoveryCandidate[];
  suppressAlerts?: boolean;
  checkpoint?: { stream: string; expected: number; metadata: Record<string, unknown> };
}

/** Items and projections must be persisted before commit. Conflicts cause a safe replay. */
export function recoveryStore(dataSource: DataSource): RecoveryStore {
  return {
    async load(connector, stream) {
      const row = await dataSource
        .getRepository(SourceCheckpointEntity)
        .findOneBy({ connector, stream });
      return {
        revision: Number(row?.metadataJson?.revision ?? 0),
        metadata: row?.metadataJson ?? {},
      };
    },
    async commit(connector, stream, expected, metadata) {
      await dataSource.transaction(async (manager) => {
        const repository = manager.getRepository(SourceCheckpointEntity);
        await repository
          .createQueryBuilder()
          .insert()
          .values({ id: randomUUID(), connector, stream })
          .orIgnore()
          .execute();
        const row = await repository.findOne({
          where: { connector, stream },
          lock: { mode: 'pessimistic_write' },
        });
        if (!row || Number(row.metadataJson?.revision ?? 0) !== expected)
          throw new Error('Discovery checkpoint conflict; replay required.');
        row.metadataJson = { ...row.metadataJson, ...metadata, revision: expected + 1 };
        if (metadata.incomplete === false) row.lastSuccessAt = new Date();
        row.cursor = typeof metadata.cursor === 'string' ? metadata.cursor : null;
        await repository.save(row);
      });
    },
  };
}

export const emptyRecoveryStore: RecoveryStore = {
  async load() {
    return { revision: 0, metadata: {} };
  },
  async commit() {
    throw new Error('Recovery checkpoint storage is required.');
  },
};
