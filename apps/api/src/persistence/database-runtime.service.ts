import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTypeOrmOptions } from '@orsem/database';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

@Injectable()
export class DatabaseRuntimeService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseRuntimeService.name);
  private source: DataSource | null = null;
  private failure: string | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async onModuleInit(): Promise<void> {
    if (this.config.fixtureMode || !this.config.databaseUrl) {
      this.failure = this.config.fixtureMode ? 'fixture mode' : 'DATABASE_URL is not configured';
      return;
    }
    this.source = new DataSource(createTypeOrmOptions(this.config.databaseUrl));
    try {
      await this.source.initialize();
      this.failure = null;
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      this.logger.error(`Database disabled: ${this.failure}`);
      this.source = null;
    }
  }

  get dataSource(): DataSource | null {
    return this.source?.isInitialized ? this.source : null;
  }

  get status(): { ready: boolean; message: string | null } {
    return { ready: this.dataSource !== null, message: this.failure };
  }

  requireDataSource(): DataSource {
    const source = this.dataSource;
    if (!source)
      throw new ServiceUnavailableException(
        '데이터베이스를 사용할 수 없습니다. 운영 상태를 확인하세요.',
      );
    return source;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.source?.isInitialized) await this.source.destroy();
  }
}
