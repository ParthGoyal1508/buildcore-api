import {
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  Post,
  Put,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AccessLevel, Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequireLevel } from '../../common/decorators/access-level.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { contentDispositionFor } from '../../common/storage/file-type';
import { XLSX_TYPE } from '../exports/inventory-workbook';
import {
  ConfirmOpeningStockImportDto,
  CreateOpeningStockDto,
  ListOpeningStockDto,
  OpeningStockImportDto,
  ReplaceOpeningStockDto,
} from './dto/opening-stock.dto';
import { OpeningStockService } from './opening-stock.service';

/**
 * Opening stock (051): what each store held when the company started recording it here. Under
 * `INVENTORY`, the permission purchases and stock are recorded under.
 */
@ApiTags('Inventory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.INVENTORY)
@Controller('inventory/opening-stock')
export class OpeningStockController {
  constructor(private readonly opening: OpeningStockService) {}

  @Get()
  @ApiOperation({
    summary:
      'Every opening entry: store, item, quantity, rate, value, as-on date',
    description:
      '`noRate` marks an entry recorded without a rate (valued at 0). `editable` is false once ' +
      'stock of that item has moved at that store since.',
  })
  list(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListOpeningStockDto,
  ) {
    return this.opening.list(caller, query);
  }

  @Get('import/template')
  @ApiOperation({
    summary:
      'The import template: Store / Site, Item Name, Quantity, Rate, As On Date',
  })
  async template(): Promise<StreamableFile> {
    return new StreamableFile(await this.opening.template(), {
      type: XLSX_TYPE,
      disposition: contentDispositionFor('opening-stock-template.xlsx'),
    });
  }

  @Post()
  @ApiOperation({
    summary: 'Add opening stock for one item at one store',
    description:
      'Posts an `opening` ledger entry, adds to the store’s stock and its weighted average rate. ' +
      'No purchase, bill or payable. 409 `OPENING_STOCK_EXISTS` when the pair already has one ' +
      '(its id is in `openingStockId`): replace it instead.',
  })
  create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateOpeningStockDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.opening.create(caller, dto, ipAddress, companyId);
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Replace an opening entry’s quantity, rate and date',
  })
  @ApiResponse({
    status: 409,
    description:
      '`OPENING_STOCK_HAS_MOVEMENTS`: stock of the item has moved at that store since.',
  })
  replace(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReplaceOpeningStockDto,
    @Ip() ipAddress: string,
  ) {
    return this.opening.replace(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an opening entry' })
  @ApiResponse({
    status: 409,
    description:
      '`OPENING_STOCK_HAS_MOVEMENTS`: stock of the item has moved at that store since.',
  })
  remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    return this.opening.remove(caller, id, ipAddress);
  }

  @Post('import/validate')
  // A POST that reads: it checks a file and writes nothing, as attendance import's validate does.
  @RequireLevel(AccessLevel.read)
  @ApiOperation({
    summary: 'Check an Opening Stock sheet without importing anything',
    description:
      'Every row is reported: matched store and item, figures, `noRate`, `replaces`, and its ' +
      'errors. Unmatched store and item names are listed once each.',
  })
  validate(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: OpeningStockImportDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.opening.validateImport(caller, dto.file, companyId);
  }

  @Post('import/confirm')
  @ApiOperation({
    summary: 'Import an Opening Stock sheet — every row in one transaction',
    description:
      'Validates again, then writes all rows or none. 400 `OPENING_STOCK_IMPORT_INVALID` (with ' +
      'the `report`) when any row is in error; 409 `OPENING_STOCK_EXISTS` when rows would replace ' +
      'existing entries and `replaceExisting` is not true.',
  })
  confirm(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: ConfirmOpeningStockImportDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.opening.confirmImport(
      caller,
      dto.file,
      dto.replaceExisting === true,
      ipAddress,
      companyId,
    );
  }
}
