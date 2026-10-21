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
import { CompositeItemsService } from '../../settings/item-masters/composite-items.service';
import {
  CreateCompositeItemDto,
  ListCompositeItemsDto,
  UpdateCompositeItemDto,
} from '../../settings/item-masters/dto/composite-item.dto';
import { InventoryItemsService } from './inventory-items.service';

/**
 * The composite item master (039), beside the item master and gated the same way (`SETTINGS`).
 * The issue form's picker reads composites through `GET /inventory/issues/composites` instead, so a
 * storekeeper with `INVENTORY` alone can issue a mix without being able to edit its recipe.
 */
@ApiTags('Inventory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.SETTINGS)
@Controller('inventory/composite-items')
export class CompositeItemsController {
  constructor(
    private readonly compositeItems: CompositeItemsService,
    private readonly inventoryItems: InventoryItemsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Paginated composite items with their sub-items' })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListCompositeItemsDto,
  ) {
    return this.compositeItems.findAll(caller, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One composite item' })
  async findOne(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.compositeItems.findOne(caller, id);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a composite item',
    description:
      'At least one sub-item, each an active item named once, with a positive quantity per ' +
      'unit of the composite (up to 6 decimals).',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateCompositeItemDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.compositeItems.create(caller, dto, ipAddress, companyId);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a composite item',
    description:
      '`components`, when sent, replaces the recipe. Set `active: false` to retire it.',
  })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateCompositeItemDto,
    @Ip() ipAddress: string,
  ) {
    return this.compositeItems.update(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a composite item',
    description: '409 once it has been issued — deactivate it instead.',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    await this.inventoryItems.removeComposite(caller, id, ipAddress);
  }
}
