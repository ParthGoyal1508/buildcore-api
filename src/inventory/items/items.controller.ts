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
  CreateItemDto,
  ListItemsDto,
  UpdateItemDto,
} from '../../settings/item-masters/dto/item.dto';
import { ItemsService } from '../../settings/item-masters/items.service';
import { InventoryItemsService } from './inventory-items.service';

/**
 * The item master, routed under `/inventory` and gated by `SETTINGS`, for the same
 * reasons as `CategoriesController` beside it.
 *
 * Reads and writes proxy to the `settings` service; only `DELETE` goes through the
 * inventory-side service, because only the delete guard needs to count rows in this
 * module's own schema.
 */
@ApiTags('Inventory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.SETTINGS)
@Controller('inventory/items')
export class ItemsController {
  constructor(
    private readonly items: ItemsService,
    private readonly inventoryItems: InventoryItemsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Paginated item list with search and category filter',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListItemsDto,
  ) {
    return this.items.findAll(caller, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One item' })
  async findOne(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.items.findOne(caller, id);
  }

  @Post()
  @ApiOperation({
    summary: 'Create an item',
    description: 'The code is allocated from the company ITEMS series.',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateItemDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.items.create(caller, dto, ipAddress, companyId);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update an item',
    description:
      'The code is immutable; set `active: false` to retire an item.',
  })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateItemDto,
    @Ip() ipAddress: string,
  ) {
    return this.items.update(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an item',
    description:
      '409 once any purchase, issue, transfer or indent line references it — ' +
      'retire it instead.',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    await this.inventoryItems.remove(caller, id, ipAddress);
  }
}
