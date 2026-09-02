import { BadRequestException, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { callerFrom } from '../../hr/caller-context';
import { SitesService } from './sites.service';

/**
 * A read-only site list, for pickers.
 *
 * Introduced by 005's frontend rather than by a Projects feature: `Employee.siteId`
 * is mandatory, so the Add Employee form cannot be completed without a way to
 * enumerate sites, and there was no endpoint that did. Kept to the single `GET` the
 * picker needs — feature 008 owns Site administration and should replace this
 * controller rather than grow it.
 *
 * Guarded with `EMPLOYEES` because that is who needs it today (the HR forms), and
 * the response carries nothing beyond a name and an id.
 */
@ApiTags('projects/sites')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.EMPLOYEES)
@Controller('projects/sites')
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @Get()
  @ApiOperation({ summary: 'Sites in this company, for a picker' })
  @ApiQuery({
    name: 'companyId',
    required: false,
    description:
      'Required only for a cross-company caller, who has no company of their own to default to.',
  })
  async list(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query('companyId') companyId?: string,
  ): Promise<{ id: string; name: string }[]> {
    const scoped = user.companyId ?? companyId;
    if (!scoped) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }
    return this.sites.listForCompany(callerFrom(user, request).rls, scoped);
  }
}
