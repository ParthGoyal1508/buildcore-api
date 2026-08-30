import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Request } from 'express';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { callerFrom } from '../caller-context';
import {
  ReEnrolmentDecisionDto,
  ReEnrolmentQueryDto,
} from './dto/re-enrolment.dto';
import { FaceEnrolmentService } from './face-enrolment.service';

/**
 * The approver's side of biometric re-enrolment (FR-014, FR-015).
 *
 * Gated on EMPLOYEES rather than ATTENDANCE, unlike the other two admin
 * controllers: approving a template replacement decides whose face the gate will
 * accept from then on, which is an identity decision about a person's record, not
 * an attendance correction.
 */
@ApiTags('Workspace Admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.EMPLOYEES)
@Controller('workspace-admin/re-enrolment-requests')
export class ReEnrolmentAdminController {
  constructor(private readonly faceEnrolment: FaceEnrolmentService) {}

  @Get()
  @ApiOperation({ summary: 'Re-enrolment requests awaiting a decision' })
  async listForReview(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query() query: ReEnrolmentQueryDto,
  ) {
    return this.faceEnrolment.listReEnrolmentRequests(
      callerFrom(user, request),
      query.status,
    );
  }

  @Post(':id/decide')
  @ApiOperation({ summary: 'Approve or reject a re-enrolment request' })
  @ApiResponse({
    status: 200,
    description:
      'An approval issues a single-use unlock valid for the configured window; a rejection closes the request and leaves the existing template in place.',
  })
  @ApiResponse({
    status: 409,
    description: 'The request has already been decided.',
  })
  async decide(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: ReEnrolmentDecisionDto,
  ) {
    return this.faceEnrolment.decideReEnrolment(
      callerFrom(user, request),
      id,
      dto.decision,
      dto.remarks,
    );
  }
}
