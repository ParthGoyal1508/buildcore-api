import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { FaceEnrolmentService } from '../biometrics/face-enrolment.service';
import { ListReEnrolmentRequestsQueryDto } from './dto/list-re-enrolment-requests.dto';
import { callerFrom } from '../caller-context';

/**
 * The HR-side re-enrolment queue (005 US10).
 *
 * A read-only view over 003's existing request data — the approve/reject decision
 * already lives at `/workspace-admin/re-enrolment-requests` and is not duplicated
 * here. Two places that can unlock a biometric template is one more than there
 * should be.
 */
@ApiTags('HR — Employees')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.EMPLOYEES)
@Controller('hr/re-enrolment-requests')
export class ReEnrolmentRequestsAdminController {
  constructor(private readonly enrolment: FaceEnrolmentService) {}

  @Get()
  @ApiOperation({
    summary: 'Re-enrolment requests, filterable by status',
    description:
      'Defaults to pending. Decisions are made through the workspace-admin ' +
      'route that owns them.',
  })
  async list(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query() query: ListReEnrolmentRequestsQueryDto,
  ) {
    return this.enrolment.listReEnrolmentRequests(
      callerFrom(user, request),
      query.status,
    );
  }
}
