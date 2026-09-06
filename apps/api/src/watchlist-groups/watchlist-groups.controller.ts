import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  groupCreateV2Schema,
  groupSaveSchema,
  groupItemsSaveSchema,
  groupCopySchema,
  watchScopeSchema,
  watchRevisionSchema,
  watchlistGroupPageQuerySchema,
  saveCompanyWatchlistMembershipsSchema,
} from '@orsem/contracts';
import { parseWith } from '../common/zod';
import { OwnWatchlistGroupAccess, RateLimit } from '../security/security';
import { WorkerQueueService } from '../operations/worker-queue.service';
import { WatchlistGroupsService, groupActor } from './watchlist-groups.service';
@Controller('watchlist-groups')
@OwnWatchlistGroupAccess()
@RateLimit(120)
export class WatchlistGroupsController {
  constructor(
    private readonly groups: WatchlistGroupsService,
    private readonly workerQueue: WorkerQueueService,
  ) {}
  @Get() list(@Req() r: Request, @Query() q: unknown) {
    return this.groups.list(groupActor(r), parseWith(watchScopeSchema, q).roomId);
  }
  @Get('shared') shared() {
    return this.groups.retired();
  }
  @Get('company-memberships/:companyId')
  @Header('Cache-Control', 'private, no-store')
  companyMemberships(@Req() r: Request, @Param('companyId') companyId: string) {
    return this.groups.companyMemberships(groupActor(r), parseWith(z.uuid(), companyId));
  }
  @Put('company-memberships/:companyId') @HttpCode(204) saveCompanyMemberships(
    @Req() r: Request,
    @Param('companyId') companyId: string,
    @Body() body: unknown,
  ) {
    return this.groups.saveCompanyMemberships(
      groupActor(r),
      parseWith(z.uuid(), companyId),
      parseWith(saveCompanyWatchlistMembershipsSchema, body),
    );
  }
  @Post() create(@Req() r: Request, @Body() b: unknown) {
    return this.groups.create(groupActor(r), parseWith(groupCreateV2Schema, b));
  }
  @Put('edit') @HttpCode(204) save(@Req() r: Request, @Body() b: unknown) {
    return this.groups.saveGroups(groupActor(r), parseWith(groupSaveSchema, b));
  }
  @Patch('order') order() {
    return this.groups.retired();
  }
  @Patch(':id') update() {
    return this.groups.retired();
  }
  @Delete(':id') remove() {
    return this.groups.retired();
  }
  @Post(':id/follow') follow() {
    return this.groups.retired();
  }
  @Delete(':id/follow') unfollow() {
    return this.groups.retired();
  }
  @Get(':id/edit') edit(@Req() r: Request, @Param('id') id: string) {
    return this.groups.editItems(groupActor(r), parseWith(z.uuid(), id));
  }
  @Put(':id/edit') @HttpCode(204) saveItems(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.groups.saveItems(
      groupActor(r),
      parseWith(z.uuid(), id),
      parseWith(groupItemsSaveSchema, b),
    );
  }
  @Post(':id/copy') copy(@Req() r: Request, @Param('id') id: string, @Body() b: unknown) {
    return this.groups.copy(groupActor(r), parseWith(z.uuid(), id), parseWith(groupCopySchema, b));
  }
  @Get(':id/items') async items(@Req() r: Request, @Param('id') id: string, @Query() q: unknown) {
    const result = await this.groups.items(
      groupActor(r),
      parseWith(z.uuid(), id),
      parseWith(watchlistGroupPageQuerySchema, q),
    );
    void this.workerQueue
      .requestGroupTossCandles(result.items.map((i) => i.company.id))
      .catch(() => undefined);
    return result;
  }
  @Post(':id/items') @HttpCode(204) add(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    const v = parseWith(
      z.object({ companyId: z.uuid(), revision: watchRevisionSchema }).strict(),
      b,
    );
    return this.groups.addItem(groupActor(r), parseWith(z.uuid(), id), v.companyId, v.revision);
  }
  @Patch(':id/items/order') itemOrder() {
    return this.groups.retired();
  }
  @Delete(':id/items/:companyId') removeItem() {
    return this.groups.retired();
  }
}
