import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { APP_CONFIG, type AppConfig } from './config/app-config';
import { SessionRuntimeService } from './security/session-runtime.service';
import { registerBodyParsers } from './common/body-parser';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const config = app.get<AppConfig>(APP_CONFIG);
  const sessions = app.get(SessionRuntimeService);
  const store = await sessions.createStore();

  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(sessions.middleware(store));
  registerBodyParsers(app);
  app.enableCors({
    origin: config.webOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  await app.listen(config.port, '127.0.0.1');
}

void bootstrap();
