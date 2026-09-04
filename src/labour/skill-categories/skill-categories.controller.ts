import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import { SkillCategoriesService } from '../../settings/skill-categories/skill-categories.service';
import { LabourWorkerService } from '../workers/labour-worker.service';
import {
  CreateSkillCategoryDto,
  UpdateSkillCategoryDto,
} from './dto/skill-category.dto';

/**
 * Skill-category master endpoints (013 US1). The table is a `settings` master, but
 * feature 013 owns the endpoints and the deletion-in-use guard — so the controller
 * lives here while delegating storage to the exported `SkillCategoriesService`. The
 * route stays under `/settings/skill-categories` per the spec's acceptance scenarios.
 */
@ApiTags('Labour')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.DAILY_WORKER_REGISTRY)
@Controller('settings/skill-categories')
export class SkillCategoriesController {
  constructor(
    private readonly skillCategories: SkillCategoriesService,
    private readonly workers: LabourWorkerService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List skill categories' })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query('companyId') companyId?: string,
  ) {
    return this.skillCategories.findAll(caller, companyId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a skill category' })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateSkillCategoryDto,
    @Ip() ip: string,
  ) {
    return this.skillCategories.create(caller, dto, ip);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a skill category' })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateSkillCategoryDto,
    @Ip() ip: string,
  ) {
    return this.skillCategories.update(caller, id, dto, ip);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a skill category',
    description:
      'Blocked with 409 while any labour worker still references it (FR-003).',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ip: string,
  ) {
    await this.workers.assertSkillCategoryUnused(caller, id);
    await this.skillCategories.remove(caller, id, ip);
  }
}
