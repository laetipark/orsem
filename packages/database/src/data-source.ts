import { UseMonthlyMarketLeaders1788412000000 } from './migrations/1788412000000-UseMonthlyMarketLeaders';
import { UseNewsMetadataOnly1788411000000 } from './migrations/1788411000000-UseNewsMetadataOnly';
import { AddMarketSelectionProfiles1788410000000 } from './migrations/1788410000000-AddMarketSelectionProfiles';
import { AddWatchlistRooms1788408000000 } from './migrations/1788408000000-AddWatchlistRooms';
import { AddManualNewsTranslations1788405000000 } from './migrations/1788405000000-AddManualNewsTranslations';
import { AddWatchlistGroups1788406000000 } from './migrations/1788406000000-AddWatchlistGroups';
import { AddNewsCompanyRelevance1788407000000 } from './migrations/1788407000000-AddNewsCompanyRelevance';
import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { ENTITIES } from './entities';
import { InitialSchema1788390000000 } from './migrations/1788390000000-InitialSchema';
import { AddAiRunIdentityUnique1788391000000 } from './migrations/1788391000000-AddAiRunIdentityUnique';
import { AddAlpacaAssetMaster1788392000000 } from './migrations/1788392000000-AddAlpacaAssetMaster';
import { PreservePriceBarSources1788393000000 } from './migrations/1788393000000-PreservePriceBarSources';
import { AddKakaoMembers1788394000000 } from './migrations/1788394000000-AddKakaoMembers';
import { AddNewsTranslation1788395000000 } from './migrations/1788395000000-AddNewsTranslation';
import { AddMarketIndicators1788396000000 } from './migrations/1788396000000-AddMarketIndicators';
import { AddWebPush1788397000000 } from './migrations/1788397000000-AddWebPush';
import { AllowSharedCompanyCik1788398000000 } from './migrations/1788398000000-AllowSharedCompanyCik';
import { AddParseIntegrity1788399000000 } from './migrations/1788399000000-AddParseIntegrity';
import { RepairLegacyParserClock1788400000000 } from './migrations/1788400000000-RepairLegacyParserClock';
import { utcMysqlDriver } from './utc-mysql-driver';
import { AddNewsArticles1788401000000 } from './migrations/1788401000000-AddNewsArticles';
import { AddDisclosureDomains1788402000000 } from './migrations/1788402000000-AddDisclosureDomains';
import { AddNewsArticleContents1788403000000 } from './migrations/1788403000000-AddNewsArticleContents';
import { MergeSamsungNewsSources1788404000000 } from './migrations/1788404000000-MergeSamsungNewsSources';

// npm workspace 스크립트의 작업 디렉터리는 packages/database입니다.
// 현재 source/dist 디렉터리를 기준으로 경로를 구해 마이그레이션과 앱에서
// 저장소 루트의 환경 파일 하나를 일관되게 사용합니다.
loadEnv({ path: resolve(__dirname, '../../../.env'), quiet: true });

export function createTypeOrmOptions(databaseUrl: string): DataSourceOptions {
  return {
    type: 'mysql',
    driver: utcMysqlDriver,
    connectorPackage: 'mysql2',
    url: databaseUrl,
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: ['DATE'],
    supportBigNumbers: true,
    bigNumberStrings: true,
    synchronize: false,
    migrationsRun: false,
    logging: false,
    entities: [...ENTITIES],
    migrations: [
      InitialSchema1788390000000,
      AddAiRunIdentityUnique1788391000000,
      AddAlpacaAssetMaster1788392000000,
      PreservePriceBarSources1788393000000,
      AddKakaoMembers1788394000000,
      AddNewsTranslation1788395000000,
      AddMarketIndicators1788396000000,
      AddWebPush1788397000000,
      AllowSharedCompanyCik1788398000000,
      AddParseIntegrity1788399000000,
      RepairLegacyParserClock1788400000000,
      AddNewsArticles1788401000000,
      AddDisclosureDomains1788402000000,
      AddNewsArticleContents1788403000000,
      MergeSamsungNewsSources1788404000000,
      AddManualNewsTranslations1788405000000,
      AddWatchlistGroups1788406000000,
      AddNewsCompanyRelevance1788407000000,
      AddWatchlistRooms1788408000000,
      AddMarketSelectionProfiles1788410000000,
      UseNewsMetadataOnly1788411000000,
      UseMonthlyMarketLeaders1788412000000,
    ],
    migrationsTableName: 'typeorm_migrations',
  };
}

const fallbackUrl = 'mysql://orsem:change-me@127.0.0.1:3306/orsem';

export function resolveDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.DATABASE_URL?.trim();
  if (!configured) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL is required for production database operations.');
    }
    return fallbackUrl;
  }
  if (environment.NODE_ENV === 'production' && configured === fallbackUrl) {
    throw new Error('DATABASE_URL cannot use the development placeholder in production.');
  }

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error('DATABASE_URL must be a valid mysql:// URL.');
  }
  if (parsed.protocol !== 'mysql:' || !parsed.hostname) {
    throw new Error('DATABASE_URL must use mysql:// and include a hostname.');
  }
  return configured;
}

export const dataSource = new DataSource(createTypeOrmOptions(resolveDatabaseUrl()));
