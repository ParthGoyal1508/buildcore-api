import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { SetPasswordDto } from './dto/set-password.dto';
import { InvitesService } from './invites.service';

/**
 * The invitee-facing half of the flow — deliberately public.
 *
 * No `JwtAuthGuard`: the whole point is that the recipient has no account to
 * authenticate with yet. The invite token is the credential, which is why both
 * routes are rate-limited — without a throttle these are an oracle for guessing
 * tokens, and unlike a login there is no account to lock after failures.
 */
@ApiTags('Account Creation')
@Controller('account-creation/invites')
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Get(':token')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Check whether an invite link is still usable' })
  async validate(@Param('token') token: string) {
    return this.invites.validate(token);
  }

  @Post(':token/set-password')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Set the account password and activate it' })
  @ApiResponse({ status: 410, description: 'Invite expired or already used.' })
  async setPassword(
    @Param('token') token: string,
    @Body() dto: SetPasswordDto,
    @Req() request: Request,
  ) {
    await this.invites.setPassword(
      token,
      dto.password,
      request.ip ?? request.socket?.remoteAddress ?? 'unknown',
    );
    return { success: true };
  }
}
