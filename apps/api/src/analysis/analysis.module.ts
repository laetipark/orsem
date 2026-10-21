import { Module } from '@nestjs/common';
import { WatchlistAccessService } from '../watchlist-groups/watchlist-access.service';
import { AnalysisConfig } from './analysis-config';
import {
  AnalysisController,
  AnalysisMappingAdminController,
  AnalysisDiffAdminController,
} from './analysis.controller';
import { AnalysisService } from './analysis.service';

@Module({
  controllers: [AnalysisController, AnalysisMappingAdminController, AnalysisDiffAdminController],
  providers: [AnalysisConfig, WatchlistAccessService, AnalysisService],
})
export class AnalysisModule {}
