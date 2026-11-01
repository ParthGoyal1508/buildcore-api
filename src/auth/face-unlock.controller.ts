import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

import { SelfService } from '../common/decorators/route-access.decorator';
import { UserEntity } from '../common/decorators/user.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { CompanyCheckExempt } from '../settings/company-selection/company-header.interceptor';
import { AuthenticatedUser } from './authenticated-user';
import { ConfirmPasswordResultDto } from './dto/confirm-password.dto';
import {
  ConfirmFaceDto,
  EnrolFaceUnlockDto,
  FaceUnlockPurposeDto,
  FaceUnlockStatusDto,
} from './dto/face-unlock.dto';
import { FaceUnlockService } from './face-unlock.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CONFIRMATION_TOKEN_HEADER } from './password-confirmation.service';

/**
 * The caller's own face as an alternative to re-entering their password (054). `@SelfService()`:
 * every route acts on the caller's own face only; which callers may use it for which purpose is
 * the purpose's permission, checked in the service. Rate-limited like sign-in.
 */
@ApiTags('auth')
@ApiBearerAuth()
@UseGuards(ThrottlerGuard, JwtAuthGuard, PermissionsGuard)
@SelfService()
@CompanyCheckExempt()
@Controller('auth/face-unlock')
export class FaceUnlockController {
  constructor(private readonly faceUnlock: FaceUnlockService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: FaceUnlockStatusDto })
  status(
    @UserEntity() caller: AuthenticatedUser,
    @Query() { purpose }: FaceUnlockPurposeDto,
  ): Promise<FaceUnlockStatusDto> {
    return this.faceUnlock.status(caller, purpose);
  }

  /** Register or replace the face. Needs a *password* confirmation for the same purpose. */
  @Put()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: FaceUnlockStatusDto })
  enrol(
    @UserEntity() caller: AuthenticatedUser,
    @Body() { purpose, photos }: EnrolFaceUnlockDto,
    @Headers(CONFIRMATION_TOKEN_HEADER) token: string | undefined,
    @Req() req: Request,
  ): Promise<FaceUnlockStatusDto> {
    return this.faceUnlock.enrol(caller, purpose, token, photos, req.ip);
  }

  @Delete()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: FaceUnlockStatusDto })
  remove(
    @UserEntity() caller: AuthenticatedUser,
    @Query() { purpose }: FaceUnlockPurposeDto,
    @Headers(CONFIRMATION_TOKEN_HEADER) token: string | undefined,
    @Req() req: Request,
  ): Promise<FaceUnlockStatusDto> {
    return this.faceUnlock.remove(caller, purpose, token, req.ip);
  }

  /** One live frame in, the same confirmation `confirm-password` returns out. */
  @Post('confirm')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: ConfirmPasswordResultDto })
  confirm(
    @UserEntity() caller: AuthenticatedUser,
    @Body() { purpose, photo }: ConfirmFaceDto,
    @Req() req: Request,
  ): Promise<ConfirmPasswordResultDto> {
    return this.faceUnlock.confirm(caller, purpose, photo, req.ip);
  }
}
