import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import {
  CreateVendorCategoryDto,
  UpdateVendorCategoryDto,
} from '../../settings/vendor-categories/dto/vendor-category.dto';
import { PartnerVendorCategoriesService } from './vendor-categories.service';

/**
 * Gated on `SETTINGS`, not `PARTNERS` (FR-015): this is a company master maintained
 * by whoever administers Settings, and it is the same permission the other masters
 * on that screen require. Reading categories in order to *tag a vendor* needs no
 * separate permission — the vendor detail response carries the ids it uses.
 */
@ApiTags('Partners')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.SETTINGS)
@Controller('partners/vendor-categories')
export class VendorCategoriesController {
  constructor(private readonly categories: PartnerVendorCategoriesService) {}

  @Get()
  @ApiOperation({
    summary: 'Vendor categories with the number of vendors using each',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query('companyId') companyId?: string,
  ) {
    return this.categories.findAll(caller, companyId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a vendor category' })
  @ApiConflictResponse({
    description: 'A category with that name already exists',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateVendorCategoryDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.categories.create(caller, dto, ipAddress, companyId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename or re-describe a vendor category' })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateVendorCategoryDto,
    @Ip() ipAddress: string,
  ) {
    return this.categories.update(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a vendor category' })
  @ApiConflictResponse({
    description: 'Vendors still deal in this category (FR-014)',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    await this.categories.remove(caller, id, ipAddress);
  }
}
