import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { callerFrom } from '../../hr/caller-context';
import { CreateSiteDto, ListSitesDto, UpdateSiteDto } from './dto/site.dto';
import { SitesService } from './sites.service';

/**
 * Site administration (008 US2).
 *
 * The controller defaults to `PROJECTS`, but the two read endpoints additionally
 * admit `EMPLOYEES`. That is not laxness — it is the reason 003's picker endpoint
 * existed at all: `hr.Employee.siteId` is mandatory, so the Add Employee form cannot
 * be completed without listing sites, and an HR administrator is not required to
 * hold `PROJECTS`. Narrowing these to `PROJECTS` alone would have broken that form
 * for exactly the people who use it most. `@RequirePermissions` is any-of
 * (`PermissionsGuard`), so naming both is the whole of the change.
 *
 * Writes stay `PROJECTS`-only: HR needs to read the site list, not to create sites.
 */
@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PROJECTS)
@Controller('projects/sites')
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  /**
   * 003's picker endpoint, preserved at its original shape.
   *
   * Returns a bare `{ id, name }[]`, not a page — HR's employee form consumes it
   * directly and would break on a `{ items, total }` envelope. The paginated
   * administrative list is `GET /projects/sites/list`.
   */
  @Get()
  @RequirePermissions(Permission.PROJECTS, Permission.EMPLOYEES)
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

  /**
   * The administrative list.
   *
   * On `/list` rather than replacing `GET /projects/sites` because that route is
   * already 003's picker and HR depends on its response shape. A static segment
   * cannot collide with `:id` below — Nest matches literals first — so the two
   * coexist without ambiguity.
   */
  @Get('list')
  @RequirePermissions(Permission.PROJECTS, Permission.EMPLOYEES)
  @ApiOperation({
    summary: 'Paginated site list with project and status filters',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListSitesDto,
  ) {
    return this.sites.findAll(caller, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a site',
    description:
      'Latitude, longitude, geofence radius and weekly-off day are required: they ' +
      'are NOT NULL columns that attendance reads on every punch.',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateSiteDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.sites.create(caller, dto, ipAddress, companyId);
  }

  @Get(':id')
  @RequirePermissions(Permission.PROJECTS, Permission.EMPLOYEES)
  @ApiOperation({
    summary: 'One site, including the geofence and weekly-off data from 003',
  })
  async findOne(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.sites.findOne(caller, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a site',
    description:
      'Partial: only the fields present in the body are written. Changing the ' +
      'geofence takes effect on the next punch.',
  })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateSiteDto,
    @Ip() ipAddress: string,
  ) {
    return this.sites.update(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a site nothing still references',
    description:
      'Returns 409 if active employees are posted to it, or if its project has ' +
      'work reports.',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    return this.sites.remove(caller, id, ipAddress);
  }
}
