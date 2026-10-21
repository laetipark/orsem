import { Inject, Injectable } from '@nestjs/common';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

@Injectable()
export class AnalysisConfig {
  readonly enabled: boolean;
  readonly documentsEnabled: boolean;
  readonly notesEnabled: boolean;
  readonly storageDir: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.enabled = process.env.ANALYSIS_ENABLED === 'true';
    this.documentsEnabled = this.enabled && process.env.ANALYSIS_DOCUMENTS_ENABLED === 'true';
    this.notesEnabled = this.documentsEnabled && process.env.ANALYSIS_NOTES_ENABLED === 'true';
    const root = config.rawDocumentDir;
    if (this.enabled) {
      if (!isAbsolute(root)) throw new Error('RAW_DOCUMENT_DIR must be an absolute path.');
      let canonical = resolve(root);
      try {
        canonical = realpathSync(root);
      } catch {
        /* A new external directory may not exist yet. */
      }
      const repo = relative(resolve(__dirname, '../../../..'), canonical);
      if (repo === '' || (!repo.startsWith(`..${sep}`) && repo !== '..' && !isAbsolute(repo))) {
        throw new Error('RAW_DOCUMENT_DIR must be outside the repository.');
      }
    }
    this.storageDir = resolve(root);
  }
}
