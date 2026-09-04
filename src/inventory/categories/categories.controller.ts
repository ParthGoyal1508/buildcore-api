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
  CreateItemCategoryDto,
  UpdateItemCategoryDto,
} from '../../settings/item-masters/dto/item-category.dto';
import { ItemCategoriesService } from '../../settings/item-masters/item-categories.service';

/**
 * Item categories, routed under `/inventory` because that is where they are used,
 * gated by `SETTINGS` because that is what they are (research.md §1, §9).
 *
 * A thin proxy: every action calls the `settings`-schema service that owns the
 * table. No query in this file touches the `settings` schema directly.
 */
@ApiTags('Inventory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.SETTINGS)
@Controller('inventory/categories')
export class CategoriesController {
  constructor(private readonly categories: ItemCategoriesService) {}

  @Get()
  @ApiOperation({
    summary: 'Item categories with their item counts',
    description:
      'Each row carries `itemCount`, so the caller can tell before trying that a ' +
      'delete will be refused.',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query('companyId') companyId?: string,
  ) {
    return this.categories.findAll(caller, companyId);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a category',
    description: 'The name is stored uppercase; a duplicate is a 409.',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateItemCategoryDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.categories.create(caller, dto, ipAddress, companyId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename a category' })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateItemCategoryDto,
    @Ip() ipAddress: string,
  ) {
    return this.categories.update(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a category',
    description: '409 while any item still belongs to it.',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    await this.categories.remove(caller, id, ipAddress);
  }
}
