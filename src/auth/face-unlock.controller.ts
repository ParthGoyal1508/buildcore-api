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
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

import { SelfService } from '../common/decorators/route-access.decorator';
import {
  framesFrom,
  LivenessFramesInterceptor,
  livenessMultipartBody,
  UploadedFrame,
} from '../common/uploads/liveness-frames';
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
import {
  CONFIRMATION_PURPOSES,
  CONFIRMATION_TOKEN_HEADER,
} from './password-confirmation.service';

const CAPTURE_BODY = livenessMultipartBody(
  {
    purpose: { type: 'string', enum: Object.keys(CONFIRMATION_PURPOSES) },
    challengeId: { type: 'string' },
  },
  ['purpose', 'challengeId'],
);

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

  /**
   * Register or replace the face from a guided capture on an `unlock-enrolment` challenge (057).
   * Needs a *password* confirmation for the same purpose.
   */
  @Put()
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(LivenessFramesInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiBody(CAPTURE_BODY)
  @ApiOkResponse({ type: FaceUnlockStatusDto })
  enrol(
    @UserEntity() caller: AuthenticatedUser,
    @Body() { purpose, challengeId }: EnrolFaceUnlockDto,
    @UploadedFiles() files: UploadedFrame[],
    @Headers(CONFIRMATION_TOKEN_HEADER) token: string | undefined,
    @Req() req: Request,
  ): Promise<FaceUnlockStatusDto> {
    return this.faceUnlock.enrol(
      caller,
      purpose,
      token,
      challengeId,
      framesFrom(files),
      req.ip,
    );
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

  /**
   * A live face in, the same confirmation `confirm-password` returns out. The capture follows an
   * `unlock-confirm` challenge (057), so a photo held up to the camera is refused.
   */
  @Post('confirm')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(LivenessFramesInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiBody(CAPTURE_BODY)
  @ApiOkResponse({ type: ConfirmPasswordResultDto })
  confirm(
    @UserEntity() caller: AuthenticatedUser,
    @Body() { purpose, challengeId }: ConfirmFaceDto,
    @UploadedFiles() files: UploadedFrame[],
    @Req() req: Request,
  ): Promise<ConfirmPasswordResultDto> {
    return this.faceUnlock.confirm(
      caller,
      purpose,
      challengeId,
      framesFrom(files),
      req.ip,
    );
  }
}
