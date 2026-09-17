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
import { AttendanceExceptionsService } from './attendance-exceptions.service';

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
  constructor(private readonly exceptions: AttendanceExceptionsService) {}

  @Get()
  @ApiOperation({
    summary: 'Punches awaiting exception resolution, with their approval state',
  })
  async listPending(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.exceptions.listPending(callerFrom(user, request), user);
  }

  @Get(':punchId')
  @ApiOperation({
    summary: 'One flagged punch and where its approval has got to',
  })
  async getOne(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('punchId') punchId: string,
  ) {
    return this.exceptions.getOne(callerFrom(user, request), user, punchId);
  }

  /**
   * The route is unchanged from before feature 016 so the interface changes once rather
   * than twice — but a decision here is now one level of a chain, not the end of the
   * matter (FR-012). Confirming at level 1 of 3 advances; it does not confirm the punch.
   */
  @Post(':punchId/resolve')
  @ApiOperation({
    summary:
      'Record a decision on a flagged punch at the current approval level',
  })
  async resolve(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('punchId') punchId: string,
    @Body() dto: ResolveExceptionDto,
  ) {
    return this.exceptions.decide(
      callerFrom(user, request),
      user,
      punchId,
      dto.resolution,
      dto.reason ?? null,
    );
  }
}
