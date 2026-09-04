import 'reflect-metadata';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

function loadWorkspaceEnvironment(): void {
  try {
    // WorkerModule을 불러오기 전에 환경을 로드합니다. 기존 프로세스 환경 변수를
    // 우선 적용한 뒤 동적 모듈 설정을 한 번만 평가하도록 하기 위함입니다.
    process.loadEnvFile(resolve(__dirname, '../../..', '.env'));
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function bootstrap(): Promise<void> {
  loadWorkspaceEnvironment();
  const { WorkerModule } = await import('./worker.module');
  const application = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['log', 'warn', 'error'],
  });
  application.enableShutdownHooks();
  new Logger('Bootstrap').log('Orsem ingestion worker is ready.');
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Worker bootstrap failed.';
  new Logger('Bootstrap').error(message);
  process.exitCode = 1;
});
