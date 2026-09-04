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
import {
  CreateEquipmentCategoryDto,
  UpdateEquipmentCategoryDto,
} from '../../settings/machinery-masters/dto/machinery-masters.dto';
import { EquipmentCategoriesService } from '../../settings/machinery-masters/equipment-categories.service';
import { EquipmentService } from '../equipment/equipment.service';

/**
 * Equipment categories, routed under `/plant` but owned by `settings`
 * (research.md §1, §10).
 *
 * The route lives here because the master PRD groups Machinery Masters with the
 * machinery module and that is where an administrator looks for it. The *table*
 * lives in `settings` because it is per-company reference data of exactly the kind
 * vendor and item categories already are — so every action below is a thin call
 * into the settings service, never a query against that schema (Principle I).
 *
 * Gated by `SETTINGS`, not `MACHINERY`: editing a master is an administrator's job,
 * not a yard supervisor's.
 */
@ApiTags('Plant')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.SETTINGS)
@Controller('plant/categories')
export class EquipmentCategoriesController {
  constructor(
    private readonly categories: EquipmentCategoriesService,
    private readonly equipment: EquipmentService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Every equipment category, with its equipment count',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query('companyId') companyId?: string,
  ) {
    const categories = await this.categories.findAll(caller, companyId);
    // The count comes from `plant.Equipment`, which the settings service may not
    // read. Resolved here, on the side of the boundary that owns the table, and in
    // one grouped query rather than one per category.
    const counts = await this.equipment.countByCategory(
      caller,
      categories.map((category) => category.id),
    );
    return categories.map((category) => ({
      ...category,
      equipmentCount: counts.get(category.id) ?? 0,
    }));
  }

  @Post()
  @ApiOperation({ summary: 'Create an equipment category' })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateEquipmentCategoryDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.categories.create(caller, dto, ipAddress, companyId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an equipment category' })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateEquipmentCategoryDto,
    @Ip() ipAddress: string,
  ) {
    return this.categories.update(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an equipment category',
    description:
      '409 once any machine or hire rate references it — retire it instead, so ' +
      'their history still resolves a category name.',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    // The equipment guard runs first because it is the one this side of the
    // boundary can answer; the settings service adds the hire-rate guard.
    await this.equipment.assertCategoryUnused(caller, id);
    await this.categories.remove(caller, id, ipAddress);
  }
}
