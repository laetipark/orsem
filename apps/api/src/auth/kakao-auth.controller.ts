import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public, RateLimit } from '../security/security';
import { KakaoAuthService } from './kakao-auth.service';

@Controller('auth/kakao')
export class KakaoAuthController {
  constructor(private readonly kakao: KakaoAuthService) {}

  @Get('config')
  @Public()
  config(@Res({ passthrough: true }) response: Response) {
    noStore(response);
    return this.kakao.publicConfig;
  }

  @Get('start')
  @Public()
  @RateLimit(10, 60_000)
  async start(@Req() request: Request, @Res() response: Response) {
    noStore(response);
    try {
      return response.redirect(302, await this.kakao.start(request));
    } catch {
      return response.redirect(302, this.kakao.returnUrl(false));
    }
  }

  @Get('callback')
  @Public()
  @RateLimit(20, 60_000)
  async callback(@Req() request: Request, @Query() query: unknown, @Res() response: Response) {
    noStore(response);
    try {
      await this.kakao.complete(request, query);
      return response.redirect(302, this.kakao.returnUrl(true));
    } catch {
      return response.redirect(302, this.kakao.returnUrl(false));
    }
  }
}

function noStore(response: Response): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
}
