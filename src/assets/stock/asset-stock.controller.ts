import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import type { Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { businessToday } from '../../common/business-date';
import { contentDispositionFor } from '../../common/storage/file-type';
import { ExportThrottle } from '../../common/throttle/app-throttle';
import { AssetStockService } from './asset-stock.service';
import { ListAssetStockDto } from './dto/asset-stock.dto';

/** Per-site asset quantities (spec FR-005). Read-only: every column here moves as
 * a side effect of an allocation, return or transfer, never by direct edit. */
@ApiTags('Assets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.ASSETS)
@Controller('assets/stock')
export class AssetStockController {
  constructor(private readonly stock: AssetStockService) {}

  @Get('export')
  @ExportThrottle()
  @ApiOperation({ summary: 'Asset quantities per site as Excel (036 L4)' })
  async export(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListAssetStockDto,
    @Res() res: Response,
  ) {
    // Every matching row: `findAll` ignores paging.
    const rows = await this.stock.findAll(caller, query);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Asset stock', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    ws.columns = [
      { header: 'Asset code', key: 'code', width: 16 },
      { header: 'Asset', key: 'name', width: 30 },
      { header: 'Site', key: 'site', width: 26 },
      { header: 'On hand', key: 'onHand', width: 11 },
      { header: 'Allocated', key: 'allocated', width: 11 },
      { header: 'In transit', key: 'inTransit', width: 11 },
      { header: 'Total', key: 'total', width: 11 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      ws.addRow({
        code: r.assetCode,
        name: r.assetName,
        site: r.siteName,
        onHand: r.onHand,
        allocated: r.allocated,
        inTransit: r.inTransit,
        total: r.total,
      });
    }
    for (const key of ['onHand', 'allocated', 'inTransit', 'total']) {
      ws.getColumn(key).numFmt = '#,##0.###';
    }
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      contentDispositionFor(
        `Asset_stock_${businessToday().toISOString().slice(0, 10)}.xlsx`,
      ),
    );
    res.send(Buffer.from(await wb.xlsx.writeBuffer()));
  }

  @Get()
  @ApiOperation({
    summary: 'Asset quantities per site',
    description:
      '036 L4: `q` searches code and name; pass `page` (and `pageSize`) for ' +
      '`{items,total,page,pageSize}` — without `page`, the whole list as an array, as before.',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListAssetStockDto,
  ) {
    return query.page
      ? this.stock.findPage(caller, query)
      : this.stock.findAll(caller, query);
  }
}
