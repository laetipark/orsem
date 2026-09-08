import type { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';

export function registerBodyParsers(app: NestExpressApplication): void {
  // News Markdown may contain 100k Korean characters; parse its larger body first.
  app.use('/api/v1/news', json({ limit: '512kb' }));
  // Nest detects existing parsers by function name, regardless of their mount path.
  // The news-only jsonParser suppresses its default parser, so install that explicitly.
  // Already-consumed news bodies pass through this parser without being read again.
  app.use(json({ limit: '100kb' }));
}
