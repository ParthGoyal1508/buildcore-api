import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Request } from 'express';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { callerFrom } from '../caller-context';
import { ResolveExceptionDto } from '../punch/dto/punch.dto';
import { PunchService } from '../punch/punch.service';

/**
 * The admin side of attendance exceptions (FR-011a).
 *
 * Deliberately not under `/my/*`: these routes act on *other* employees' punches,
 * which is exactly what the `/my/*` prefix promises never to do. Access is gated on
 * ATTENDANCE, and RLS still confines every result to the admin's own company.
 */
@ApiTags('Workspace Admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.ATTENDANCE)
@Controller('workspace-admin/attendance-exceptions')
export class AttendanceExceptionsController {
  constructor(private readonly punch: PunchService) {}

  @Get()
  @ApiOperation({ summary: 'Punches awaiting exception resolution' })
  async listPending(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.punch.listPendingExceptions(callerFrom(user, request));
  }

  @Post(':punchId/resolve')
  @ApiOperation({ summary: 'Confirm or reject a flagged punch' })
  async resolve(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('punchId') punchId: string,
    @Body() dto: ResolveExceptionDto,
  ) {
    return this.punch.resolveException(
      callerFrom(user, request),
      punchId,
      dto.resolution,
    );
  }
}
