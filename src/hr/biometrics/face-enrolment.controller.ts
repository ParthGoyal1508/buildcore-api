import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { UserEntity } from '../../common/decorators/user.decorator';
import { callerFrom } from '../caller-context';
import { EnrolFaceDto, FaceEnrolmentStatusDto } from './dto/enrol.dto';
import { FaceEnrolmentService } from './face-enrolment.service';

/**
 * The caller's own face enrolment.
 *
 * Every route resolves the employee from the JWT, and none accepts an employee
 * identifier — that absence is what enforces FR-028 here, so a route added later
 * must keep it (see the contract's preamble).
 */
@ApiTags('My Workspace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('my/face-enrol')
export class FaceEnrolmentController {
  constructor(private readonly faceEnrolment: FaceEnrolmentService) {}

  @Get()
  @ApiOperation({
    summary: "Current enrolment status for the caller's own record",
  })
  async getStatus(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<FaceEnrolmentStatusDto> {
    return this.faceEnrolment.getStatus(callerFrom(user, request));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Enrol from 3–5 photos with recorded consent' })
  async enrol(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Body() dto: EnrolFaceDto,
  ): Promise<FaceEnrolmentStatusDto> {
    return this.faceEnrolment.enrol(
      callerFrom(user, request),
      dto.photos,
      dto.consentMethod,
    );
  }

  @Delete('consent')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Withdraw consent — deletes the stored template and photos',
  })
  async withdrawConsent(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<FaceEnrolmentStatusDto> {
    return this.faceEnrolment.withdrawConsent(callerFrom(user, request));
  }
}
