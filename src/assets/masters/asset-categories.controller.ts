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
import { AssetCategoriesService } from '../../settings/asset-masters/asset-categories.service';
import {
  CreateAssetCategoryDto,
  UpdateAssetCategoryDto,
} from '../../settings/asset-masters/dto/asset-masters.dto';
import { AssetService } from '../register/asset.service';

/**
 * Asset categories, routed under `/assets` but owned by `settings`.
 *
 * The same arrangement `EquipmentCategoriesController` documents: the route lives
 * with the module an administrator looks for it in, the table lives with the rest of
 * the company's reference data, and every action here is a thin call into the
 * settings service rather than a query against that schema (Principle I).
 *
 * Gated by `SETTINGS`, not `ASSETS`: editing a master is an administrator's job, not
 * a store keeper's.
 */
@ApiTags('Assets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.SETTINGS)
@Controller('assets/categories')
export class AssetCategoriesController {
  constructor(
    private readonly categories: AssetCategoriesService,
    private readonly assets: AssetService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Every asset category, with its asset count and book value',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query('companyId') companyId?: string,
  ) {
    const categories = await this.categories.findAll(caller, companyId);
    const ids = categories.map((category) => category.id);
    // Both figures count rows in the `assets` schema, which the settings service may
    // not read. Resolved here, on the side of the boundary that owns them, and in
    // two grouped queries rather than two per category.
    const [counts, values] = await Promise.all([
      this.assets.countByCategory(caller, ids),
      this.assets.bookValueByCategory(caller, ids),
    ]);
    return categories.map((category) => ({
      ...category,
      assetCount: counts.get(category.id) ?? 0,
      totalBookValue: values.get(category.id) ?? 0,
    }));
  }

  @Post()
  @ApiOperation({ summary: 'Create an asset category' })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateAssetCategoryDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.categories.create(caller, dto, ipAddress, companyId);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update an asset category',
    description:
      '409 on a trackingMode change once any asset is registered under it ' +
      '(FR-003) — the two modes have different allocation semantics, and a flip ' +
      'would reinterpret every existing row.',
  })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateAssetCategoryDto,
    @Ip() ipAddress: string,
  ) {
    if (dto.trackingMode !== undefined) {
      await this.assets.assertTrackingModeChangeable(
        caller,
        id,
        dto.trackingMode,
      );
    }
    return this.categories.update(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an asset category',
    description:
      '409 once any asset references it — retire it instead, so their history ' +
      'still resolves a category name.',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    await this.assets.assertCategoryUnused(caller, id);
    await this.categories.remove(caller, id, ipAddress);
  }
}
