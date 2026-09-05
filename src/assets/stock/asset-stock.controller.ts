import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { AssetStockService } from './asset-stock.service';

/** Per-site asset quantities (spec FR-005). Read-only: every column here moves as
 * a side effect of an allocation, return or transfer, never by direct edit. */
@ApiTags('Assets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.ASSETS)
@Controller('assets/stock')
export class AssetStockController {
  constructor(private readonly stock: AssetStockService) {}

  @Get()
  @ApiOperation({ summary: 'Asset quantities per site' })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query('assetId') assetId?: string,
    @Query('siteId') siteId?: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.stock.findAll(caller, { assetId, siteId, companyId });
  }
}
