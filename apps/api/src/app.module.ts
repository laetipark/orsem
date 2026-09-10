import { CompanyInformationApiService } from './resources/company-information.service';
import { CompanyLogoController, CompanyLogoService } from './resources/company-logo.service';
import { WatchlistAccessService } from './watchlist-groups/watchlist-access.service';
import { WatchlistRoomsController } from './watchlist-groups/watchlist-rooms.controller';
import { WatchlistRoomsService } from './watchlist-groups/watchlist-rooms.service';
import { CompanyObservationService } from './watchlist-groups/company-observation.service';
import { NewsTranslationEditorController } from './resources/news-translation-editor.controller';
import { NewsTranslationEditorService } from './resources/news-translation-editor.service';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { resolve } from 'node:path';
import { APP_CONFIG, loadAppConfig } from './config/app-config';
import { DatabaseRuntimeService } from './persistence/database-runtime.service';
import { FixtureStoreService } from './fixtures/fixture-store.service';
import { OrsemDataService } from './resources/orsem-data.service';
import { LivePriceService } from './resources/live-price.service';
import { RESOURCE_CONTROLLERS } from './resources/resource.controllers';
import { HealthController, OperationsController } from './operations/operations.controller';
import { AuthService } from './auth/auth.service';
import { MemberService } from './auth/member.service';
import { KakaoAuthService } from './auth/kakao-auth.service';
import { KakaoAuthController } from './auth/kakao-auth.controller';
import { AuthController } from './auth/auth.controller';
import {
  AdminSessionGuard,
  CsrfGuard,
  HybridRateLimitGuard,
  OriginGuard,
} from './security/security';
import { SessionRuntimeService } from './security/session-runtime.service';
import { BotService } from './bots/bot.service';
import {
  DeviceTokenGuard,
  DiscordBotController,
  DiscordServiceGuard,
  MessengerController,
} from './bots/bot.controllers';
import { FilingDocumentsController } from './documents/filing-documents.controller';
import { WorkerQueueService } from './operations/worker-queue.service';
import { SearchController } from './search/search.controller';
import { SearchService } from './search/search.service';
import { MarketsController } from './markets/markets.controller';
import { MarketsService } from './markets/markets.service';
import { NotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { NaverNewsSearchController } from './news-search/naver-news-search.controller';
import { NaverNewsSearchService } from './news-search/naver-news-search.service';
import { NaverFocusNewsService } from './news-search/naver-focus-news.service';
import { NaverNewsBudgetService } from './news-search/naver-news-budget.service';
import { WatchlistGroupsController } from './watchlist-groups/watchlist-groups.controller';
import { WatchlistGroupsService } from './watchlist-groups/watchlist-groups.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: resolve(__dirname, '../../../.env'),
    }),
  ],
  controllers: [
    CompanyLogoController,
    NewsTranslationEditorController,
    AuthController,
    KakaoAuthController,
    SearchController,
    NaverNewsSearchController,
    WatchlistGroupsController,
    WatchlistRoomsController,
    MarketsController,
    NotificationsController,
    ...RESOURCE_CONTROLLERS,
    HealthController,
    OperationsController,
    FilingDocumentsController,
    MessengerController,
    DiscordBotController,
  ],
  providers: [
    { provide: APP_CONFIG, useFactory: loadAppConfig },
    DatabaseRuntimeService,
    SessionRuntimeService,
    FixtureStoreService,
    OrsemDataService,
    CompanyInformationApiService,
    CompanyLogoService,
    NewsTranslationEditorService,
    LivePriceService,
    AuthService,
    MemberService,
    KakaoAuthService,
    SearchService,
    NaverNewsSearchService,
    NaverFocusNewsService,
    NaverNewsBudgetService,
    WatchlistGroupsService,
    WatchlistAccessService,
    WatchlistRoomsService,
    CompanyObservationService,
    MarketsService,
    NotificationsService,
    BotService,
    WorkerQueueService,
    DeviceTokenGuard,
    DiscordServiceGuard,
    { provide: APP_GUARD, useClass: AdminSessionGuard },
    { provide: APP_GUARD, useClass: OriginGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: HybridRateLimitGuard },
  ],
})
export class AppModule {}
