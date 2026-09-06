import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  roomCreateSchema,
  roomUpdateSchema,
  roomMemberUpdateSchema,
  watchActorKeySchema,
  watchRevisionSchema,
  watchIdsSchema,
} from '@orsem/contracts';
import { parseWith } from '../common/zod';
import { OwnWatchlistGroupAccess, RateLimit } from '../security/security';
import { groupActor } from './watchlist-access.service';
import { WatchlistRoomsService } from './watchlist-rooms.service';
const idSchema = z.uuid();
const revisionSchema = z.object({ revision: watchRevisionSchema }).strict();
@Controller('watchlist-rooms')
@OwnWatchlistGroupAccess()
@RateLimit(120)
export class WatchlistRoomsController {
  constructor(private readonly rooms: WatchlistRoomsService) {}
  @Get() list(@Req() r: Request) {
    return this.rooms.list(groupActor(r));
  }
  @Get('directory') directory(@Req() r: Request, @Query() q: unknown) {
    const { offset } = parseWith(
      z.object({ offset: z.coerce.number().int().min(0).max(100000).default(0) }).strict(),
      q,
    );
    return this.rooms.directory(groupActor(r), offset);
  }
  @Post() create(@Req() r: Request, @Body() b: unknown) {
    return this.rooms.create(groupActor(r), parseWith(roomCreateSchema, b));
  }
  @Patch('order') @HttpCode(204) order(@Req() r: Request, @Body() b: unknown) {
    return this.rooms.order(
      groupActor(r),
      parseWith(z.object({ ids: watchIdsSchema.max(100) }).strict(), b).ids,
    );
  }
  @Get(':id') detail(@Req() r: Request, @Param('id') id: string) {
    return this.rooms.detail(groupActor(r), parseWith(idSchema, id));
  }
  @Patch(':id') @HttpCode(204) update(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.rooms.update(
      groupActor(r),
      parseWith(idSchema, id),
      parseWith(roomUpdateSchema, b),
    );
  }
  @Delete(':id') @HttpCode(204) remove(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.rooms.remove(
      groupActor(r),
      parseWith(idSchema, id),
      parseWith(revisionSchema, b).revision,
    );
  }
  @Post(':id/requests') @HttpCode(204) request(@Req() r: Request, @Param('id') id: string) {
    return this.rooms.request(groupActor(r), parseWith(idSchema, id));
  }
  @Delete(':id/requests') @HttpCode(204) cancel(@Req() r: Request, @Param('id') id: string) {
    return this.rooms.request(groupActor(r), parseWith(idSchema, id), true);
  }
  @Post(':id/requests/:actor/review') @HttpCode(204) review(
    @Req() r: Request,
    @Param('id') id: string,
    @Param('actor') actor: string,
    @Body() b: unknown,
  ) {
    const v = parseWith(revisionSchema.extend({ approve: z.boolean() }), b);
    return this.rooms.review(
      groupActor(r),
      parseWith(idSchema, id),
      parseWith(watchActorKeySchema, actor),
      v.approve,
      v.revision,
    );
  }
  @Patch(':id/members/:actor') @HttpCode(204) member(
    @Req() r: Request,
    @Param('id') id: string,
    @Param('actor') actor: string,
    @Body() b: unknown,
  ) {
    return this.rooms.member(
      groupActor(r),
      parseWith(idSchema, id),
      parseWith(watchActorKeySchema, actor),
      parseWith(roomMemberUpdateSchema, b),
    );
  }
  @Delete(':id/members/:actor') @HttpCode(204) kick(
    @Req() r: Request,
    @Param('id') id: string,
    @Param('actor') actor: string,
    @Body() b: unknown,
  ) {
    return this.rooms.removeMember(
      groupActor(r),
      parseWith(idSchema, id),
      parseWith(watchActorKeySchema, actor),
      parseWith(revisionSchema, b).revision,
    );
  }
  @Post(':id/leave') @HttpCode(204) leave(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    const a = groupActor(r);
    return this.rooms.removeMember(
      a,
      parseWith(idSchema, id),
      a.key,
      parseWith(revisionSchema, b).revision,
    );
  }
  @Post(':id/transfer') @HttpCode(204) transfer(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    const v = parseWith(revisionSchema.extend({ actorKey: watchActorKeySchema }), b);
    return this.rooms.transfer(groupActor(r), parseWith(idSchema, id), v.actorKey, v.revision);
  }
}
