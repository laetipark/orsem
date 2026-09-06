import { SourceCheckpointEntity } from '@orsem/database';
import { OpenDartApiError } from '@orsem/opendart-parser';
import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { OpenDartClient } from '../opendart/opendart.client';
import { ConnectorHealthService } from '../connectors/connector-health.service';
import { financialFields } from './company-information';

@Injectable()
export class CompanyInformationService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: ReturnType<typeof setInterval>;
  private flight: Promise<void> | null = null;
  private stopped = false;
  constructor(
    private readonly source: DataSource,
    private readonly dart: OpenDartClient,
    private readonly health: ConnectorHealthService,
  ) {}
  onApplicationBootstrap() {
    if (!this.dart.enabled) return;
    this.timer = setInterval(() => void this.refresh(), 15 * 60_000);
    this.timer.unref();
    void this.refresh();
  }
  async onApplicationShutdown() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.flight;
  }
  refresh() {
    if (!this.flight)
      this.flight = this.run()
        .catch(() => undefined)
        .finally(() => {
          this.flight = null;
        });
    return this.flight;
  }
  private async run() {
    if (!this.dart.enabled || this.stopped || (await this.health.openDartPausedUntil())) return;
    const runner = this.source.createQueryRunner();
    await runner.connect();
    let locked = false;
    try {
      const [lock] = await runner.query("SELECT GET_LOCK('orsem-company-information',0) acquired");
      locked = Number(lock?.acquired) === 1;
      if (!locked) return;
      const companies: Array<{ id: string; corpCode: string }> =
        await runner.query(`SELECT c.id,c.corp_code corpCode FROM companies c
        LEFT JOIN (SELECT company_id,MAX(observed_at) collected FROM company_information_snapshots GROUP BY company_id) latest ON latest.company_id=c.id
        LEFT JOIN source_checkpoints failure ON failure.connector='COMPANY_INFORMATION_FAILURE' AND failure.stream=c.id
        WHERE (failure.last_success_at IS NULL OR failure.last_success_at < UTC_TIMESTAMP() - INTERVAL 1 DAY) AND c.corp_code IS NOT NULL AND c.is_listed=1 AND (latest.collected IS NULL OR latest.collected < UTC_TIMESTAMP() - INTERVAL 7 DAY)
        AND (EXISTS (SELECT 1 FROM source_checkpoints request WHERE request.connector='COMPANY_INFORMATION' AND request.stream=c.id) OR EXISTS (SELECT 1 FROM watchlist_group_items i JOIN watchlist_groups g ON g.id=i.group_id WHERE i.company_id=c.id AND g.room_id IS NULL)
          OR EXISTS (SELECT 1 FROM market_cap_memberships m JOIN market_selection_state st ON st.active_snapshot_id=m.snapshot_id WHERE m.company_id=c.id))
        ORDER BY latest.collected,c.id LIMIT 4`);
      const now = new Date();
      const year = new Date(now.getTime() + 9 * 3600_000).getUTCFullYear();
      for (const company of companies) {
        if (this.stopped || (await this.health.openDartPausedUntil())) break;
        try {
          const month = new Date(now.getTime() + 9 * 3600_000).getUTCMonth() + 1;
          const annualYear = month >= 4 ? year - 1 : year - 2;
          const raw = await this.dart.companyInformation(company.corpCode, annualYear, '11011');
          const annualFields = financialFields(raw, annualYear, '11011', now.toISOString());
          const quarter =
            month >= 11 ? '11014' : month >= 8 ? '11012' : month >= 5 ? '11013' : null;
          const recent = quarter
            ? await this.dart.companyInformation(company.corpCode, year, quarter)
            : null;
          const recentFields =
            recent?.financials && quarter
              ? financialFields(recent, year, quarter, now.toISOString())
              : [];
          let fields = recentFields.length
            ? [
                ...recentFields.filter((field) => !['eps', 'dividend'].includes(field.key)),
                ...annualFields.filter((field) => ['eps', 'dividend'].includes(field.key)),
              ]
            : annualFields;
          if (!raw.profile && !raw.financials && !raw.dividends && !recent?.financials)
            throw new Error('Company report unavailable');
          const [previous] = await runner.query(
            'SELECT fields_json fields FROM company_information_snapshots WHERE company_id=? ORDER BY observed_at DESC LIMIT 1',
            [company.id],
          );
          const stored =
            typeof previous?.fields === 'string' ? JSON.parse(previous.fields) : previous?.fields;
          if (Array.isArray(stored))
            fields = fields.map((field) =>
              field.value === null
                ? (stored.find(
                    (older: { key: string; value: string | null }) =>
                      older.key === field.key && older.value !== null,
                  ) ?? field)
                : field,
            );
          await runner.query(
            'INSERT INTO company_information_snapshots(id,company_id,source,report_year,report_code,basis_date,observed_at,source_url,rights_mode,fields_json,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            [
              randomUUID(),
              company.id,
              'OPENDART',
              recent?.financials ? year : annualYear,
              recent?.financials ? quarter : '11011',
              null,
              now,
              'https://opendart.fss.or.kr/',
              'OFFICIAL_PUBLIC_DATA',
              JSON.stringify(fields),
              JSON.stringify({ annual: raw, recent }),
            ],
          );
        } catch (error) {
          if (error instanceof OpenDartApiError && error.status === '020') throw error;
          await this.source.getRepository(SourceCheckpointEntity).upsert(
            {
              connector: 'COMPANY_INFORMATION_FAILURE',
              stream: company.id,
              lastSuccessAt: new Date(),
              lastSuccessDate: null,
              cursor: null,
              metadataJson: { state: 'RETRY_PENDING', nextAttemptAfterHours: 24 },
            },
            ['connector', 'stream'],
          );
        }
      }
    } catch (error) {
      if (error instanceof OpenDartApiError && error.status === '020') {
        const local = new Date(Date.now() + 9 * 3600_000);
        local.setUTCHours(24, 0, 0, 0);
        await this.health.pauseOpenDartUntil(new Date(local.getTime() - 9 * 3600_000));
      }
    } finally {
      if (locked)
        await runner
          .query("SELECT RELEASE_LOCK('orsem-company-information')")
          .catch(() => undefined);
      await runner.release();
    }
  }
}
