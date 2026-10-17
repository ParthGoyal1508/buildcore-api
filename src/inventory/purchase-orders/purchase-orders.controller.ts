import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import {
  ListPurchaseOrdersDto,
  OpenPurchaseOrderLinesDto,
} from './dto/purchase-order.dto';
import { PurchaseOrdersService } from './purchase-orders.service';

/**
 * Purchase orders, structured (036 M9). Read-only: a PO is still composed, approved and issued as a
 * letter (`/letters`); these routes read the structure behind the issued ones. INVENTORY, the
 * permission the PO letter kind itself requires (`letter-permissions.ts`).
 */
@ApiTags('Inventory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.INVENTORY)
@Controller('inventory/purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly orders: PurchaseOrdersService) {}

  @Get()
  @ApiOperation({
    summary: 'Issued purchase orders with ordered, received, billed and paid',
  })
  async list(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListPurchaseOrdersDto,
  ) {
    return { purchaseOrders: await this.orders.list(caller, query) };
  }

  // Before `:id`, so "open-lines" is not read as a PO id.
  @Get('open-lines')
  @ApiOperation({
    summary:
      'PO lines that can still be received against, for the purchase form',
  })
  async openLines(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: OpenPurchaseOrderLinesDto,
  ) {
    return { lines: await this.orders.openLines(caller, query) };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One purchase order traced: lines → GRNs → bills → payments',
    description:
      'By the PO letter id (what the Purchase orders page lists) or the PO id.',
  })
  async detail(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.orders.detail(caller, id);
  }
}
