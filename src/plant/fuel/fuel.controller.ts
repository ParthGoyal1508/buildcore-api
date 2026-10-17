import {
  Body,
  Controller,
  Get,
  Ip,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { businessToday } from '../../common/business-date';
import { ExportThrottle } from '../../common/throttle/app-throttle';
import { allPages, ddmmyyyy, sendListXlsx } from '../list-export';
import {
  CreateFuelEntryDto,
  FuelSummaryDto,
  ListFuelDto,
} from './dto/fuel.dto';
import { FuelService } from './fuel.service';

/** Fuel entries and variance alerts (006 US4), gated by `FUEL`. */
@ApiTags('Plant')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.FUEL)
@Controller('plant/fuel')
export class FuelController {
  constructor(private readonly fuel: FuelService) {}

  // Declared before the parameterless `GET /` handler would matter — Nest matches
  // in declaration order, and `summary` must not be read as a filter value.
  @Get('summary')
  @ApiOperation({ summary: 'Per-machine fuel totals for one calendar month' })
  async summary(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: FuelSummaryDto,
  ) {
    return this.fuel.getMonthlySummary(caller, query);
  }

  @Get('export.xlsx')
  @ExportThrottle()
  @ApiOperation({
    summary: 'The filtered fuel entries as Excel (036 K16)',
    description:
      'Same filters as the list, without paging (at most 5,000 rows).',
  })
  async export(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListFuelDto,
    @Res() res: Response,
  ) {
    const rows = await allPages((page, pageSize) =>
      this.fuel.findAll(caller, { ...query, page, pageSize }),
    );
    await sendListXlsx(
      res,
      `Fuel_${ddmmyyyy(businessToday())}.xlsx`,
      'Fuel',
      [
        { header: 'Date', width: 12, value: (r) => ddmmyyyy(r.date) },
        { header: 'Machine code', width: 16, value: (r) => r.equipmentCode },
        { header: 'Machine', width: 26, value: (r) => r.equipmentName },
        {
          header: 'Litres',
          width: 12,
          value: (r) => r.quantity,
          numFmt: '#,##0.###',
        },
        {
          header: 'Rate (₹/litre)',
          width: 12,
          value: (r) => r.rate,
          numFmt: '#,##0.00',
        },
        {
          header: 'Amount (₹)',
          width: 14,
          value: (r) => r.amount,
          numFmt: '#,##0.00',
        },
        { header: 'Vendor', width: 24, value: (r) => r.vendorName },
        { header: 'Site', width: 24, value: (r) => r.siteName },
        {
          header: 'Variance %',
          width: 11,
          value: (r) => r.variancePercent,
          numFmt: '0.0',
        },
        {
          header: 'Variance alert',
          width: 12,
          value: (r) => (r.varianceAlert ? 'Yes' : ''),
        },
      ],
      rows,
    );
  }

  @Get()
  @ApiOperation({ summary: 'Paginated fuel entries' })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListFuelDto,
  ) {
    return this.fuel.findAll(caller, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Record a fuel entry',
    description:
      "Computes amount and variance against the machine category's own configured " +
      'threshold, and emits a `fuel_variance` event when it is exceeded.',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateFuelEntryDto,
    @Ip() ipAddress: string,
  ) {
    return this.fuel.create(caller, dto, ipAddress);
  }
}
