import {
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import {
  CreateProjectDto,
  ListProjectsDto,
  UpdateProjectDto,
} from './dto/project.dto';
import { ProjectsService } from './projects.service';

/**
 * The project portfolio (008 US3).
 *
 * Note what is *not* here: `ProjectLockGuard`. Unlocking a project is a PATCH to the
 * project itself, so guarding this controller would make every lock permanent. The
 * guard belongs on the data-entry controllers (BOQ, DWR, revenue, bills) that later
 * stories add.
 */
@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PROJECTS)
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @ApiOperation({
    summary: 'Paginated portfolio list with search, status and client filters',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListProjectsDto,
  ) {
    return this.projects.findAll(caller, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a project',
    description:
      'Omit `code` to allocate the next one in the company PROJECTS series. A ' +
      'cross-company caller may name the company with `?companyId=`.',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateProjectDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.projects.create(caller, dto, ipAddress, companyId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One project with its aggregated tab data',
    description:
      'Employees are real. Machinery and materials come back empty with their ' +
      'modules named in `unavailableModules`, because features 006 and 009 have ' +
      'not shipped — which is not the same as there being none.',
  })
  async findOne(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.projects.findOne(caller, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a project, including its lock state',
    description:
      'Partial: only the fields present in the body are written. Setting ' +
      '`isLocked` is audit-logged with its before and after.',
  })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateProjectDto,
    @Ip() ipAddress: string,
  ) {
    return this.projects.update(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a project nothing has been recorded against',
    description:
      'Returns 409 naming the work reports, revenue entries, RA bills or BOQ ' +
      'groups that would be cascaded away.',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    return this.projects.remove(caller, id, ipAddress);
  }
}
