import {
  Body,
  Controller,
  Get,
  Ip,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccessLevel, Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequireLevel } from '../../common/decorators/access-level.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { contentDispositionFor } from '../../common/storage/file-type';
import { XLSX_TYPE } from '../exports/inventory-workbook';
import { AgreedRatesService } from './agreed-rates.service';
import { ListAgreedRatesDto, VendorRateImportDto } from './dto/agreed-rate.dto';

/**
 * Agreed vendor rates (028), listed and imported up front (051). `INVENTORY`, the permission the
 * purchases that are held to these rates are recorded under.
 */
@ApiTags('Inventory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.INVENTORY)
@Controller('inventory/vendor-rates')
export class AgreedRatesController {
  constructor(private readonly rates: AgreedRatesService) {}

  @Get()
  @ApiOperation({
    summary: 'The agreed rates in force, by vendor and item',
    description:
      '`source` is `purchase` when a first purchase set the rate, `import` when it was entered up front.',
  })
  list(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListAgreedRatesDto,
  ) {
    return this.rates.list(caller, query);
  }

  @Get('import/template')
  @ApiOperation({
    summary: 'The import template: Vendor Name, Item Name, Rate, Valid From',
  })
  async template(): Promise<StreamableFile> {
    return new StreamableFile(await this.rates.template(), {
      type: XLSX_TYPE,
      disposition: contentDispositionFor('vendor-rates-template.xlsx'),
    });
  }

  @Post('import/validate')
  // A POST that reads: it checks a file and writes nothing.
  @RequireLevel(AccessLevel.read)
  @ApiOperation({
    summary: 'Check a Vendor Rates sheet without importing anything',
    description:
      'Each row is `create` (no rate in force), `unchanged` (the same rate is), `conflict` (a ' +
      'different rate is — not overwritten; a change needs approval), `daily` (a daily-rate item, ' +
      'set on Daily rates instead) or `error`.',
  })
  validate(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: VendorRateImportDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.rates.validateImport(caller, dto.file, companyId);
  }

  @Post('import/confirm')
  @ApiOperation({
    summary:
      'Record the `create` rows of a Vendor Rates sheet, in one transaction',
    description:
      'Validates again. 400 `VENDOR_RATE_IMPORT_INVALID` (with the `report`) when any row is in ' +
      'error, and nothing is written. Conflicts, unchanged and daily-rate rows are reported only.',
  })
  confirm(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: VendorRateImportDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.rates.confirmImport(caller, dto.file, ipAddress, companyId);
  }
}
