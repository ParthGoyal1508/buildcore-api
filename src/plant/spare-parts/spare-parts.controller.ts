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
  CreateSparePartDto,
  ListSparePartsDto,
  ReceiveSparePartDto,
  UpdateSparePartDto,
} from './dto/spare-part.dto';
import { SparePartsService } from './spare-parts.service';

/**
 * The spare parts catalogue and its stock (006 US9), gated by `MAINTENANCE`.
 *
 * FR-028 reuses the permission this feature already introduces rather than adding a
 * `SPARE_PARTS` value: a storekeeper who may not see maintenance jobs has no use for
 * a parts list, and the two are worked by the same people.
 */
@ApiTags('Plant')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.MAINTENANCE)
@Controller('plant/spare-parts')
export class SparePartsController {
  constructor(private readonly spareParts: SparePartsService) {}

  // Ahead of `:id` — Nest matches in declaration order, and `reconciliation` must
  // not be read as a part id.
  @Get('reconciliation')
  @ApiOperation({
    summary:
      'Parts linked to an inventory item, with both balances side by side',
    description:
      'FR-024. The two stocks are independent by design; this exists to make a ' +
      'divergence visible rather than to reconcile them.',
  })
  async reconciliation(@UserEntity() caller: AuthenticatedUser) {
    return this.spareParts.reconciliation(caller);
  }

  @Get()
  @ApiOperation({
    summary: 'Paginated spare parts with stock, average rate and stock value',
    description:
      '`belowReorder=true` is resolved before paging, so a filtered page is a full ' +
      'page and the total is right.',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListSparePartsDto,
  ) {
    return this.spareParts.findAll(caller, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One spare part' })
  async findOne(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.spareParts.findOne(caller, id);
  }

  @Get(':id/movements')
  @ApiOperation({
    summary: 'Receipt, consumption and reversal history for a part',
  })
  async movements(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.spareParts.listMovements(caller, { sparePartId: id });
  }

  @Post()
  @ApiOperation({
    summary: 'Register a spare part',
    description:
      '409 on a duplicate part number. Opening stock is always zero.',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateSparePartDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.spareParts.create(caller, dto, ipAddress, companyId);
  }

  @Post(':id/receipts')
  @ApiOperation({
    summary: 'Receive stock',
    description:
      "Recalculates the part's weighted average rate by the same formula 009 " +
      'applies to inventory items (FR-017).',
  })
  async receive(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReceiveSparePartDto,
    @Ip() ipAddress: string,
  ) {
    return this.spareParts.receive(caller, id, dto, ipAddress);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a spare part' })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateSparePartDto,
    @Ip() ipAddress: string,
  ) {
    return this.spareParts.update(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a spare part',
    description:
      '409 once it has any movement history — retire it instead, so the machines ' +
      'it was fitted to keep theirs.',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    await this.spareParts.remove(caller, id, ipAddress);
  }
}
