import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { ListStockDto } from './dto/stock.dto';
import { StockQueryService } from './stock-query.service';

@ApiTags('Inventory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.INVENTORY)
@Controller('inventory/stock')
export class StockController {
  constructor(private readonly stock: StockQueryService) {}

  @Get()
  @ApiOperation({
    summary: 'Stock by item and store',
    description:
      '`inStock`, `stockValue` and `belowReorderLevel` are computed on read and ' +
      'never stored (FR-014). Only item-sites that have a balance row appear — an ' +
      'item never received anywhere has no row to show.',
  })
  async list(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListStockDto,
  ) {
    return this.stock.list(caller, query);
  }

  @Get(':itemId/:siteId')
  @ApiOperation({
    summary: 'Available stock for one item at one store',
    description:
      'Drives the available-quantity hint on the Issue and Transfer forms. An ' +
      'item never received at that store returns 0 rather than 404.',
  })
  async hint(
    @UserEntity() caller: AuthenticatedUser,
    @Param('itemId') itemId: string,
    @Param('siteId') siteId: string,
  ) {
    return this.stock.hint(caller, itemId, siteId);
  }
}
