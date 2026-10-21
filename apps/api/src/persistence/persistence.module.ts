import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadAppConfig } from '../config/app-config';
import { DatabaseRuntimeService } from './database-runtime.service';

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: loadAppConfig }, DatabaseRuntimeService],
  exports: [APP_CONFIG, DatabaseRuntimeService],
})
export class PersistenceModule {}
