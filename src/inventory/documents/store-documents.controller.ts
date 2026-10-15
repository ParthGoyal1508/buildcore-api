import {
  BadRequestException,
  Controller,
  Get,
  Param,
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
import {
  type FormFormat,
  formFormatOf,
  sendForm,
} from '../../common/form-document';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { StoreDocumentsService } from './store-documents.service';

function formatOf(value: string): FormFormat {
  const kind = formFormatOf(value, ['pdf', 'xlsx', 'docx']);
  if (!kind) throw new BadRequestException('Format must be pdf, xlsx or docx');
  return kind;
}

/**
 * The store documents in the client's formats (2026-10-15): indent, delivery challan, GRN, issue
 * slip, stock transfer slip and the daily issue register — each as PDF, Excel or Word.
 */
@ApiTags('Inventory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.INVENTORY)
@Controller('inventory/documents')
export class StoreDocumentsController {
  constructor(private readonly documents: StoreDocumentsService) {}

  @Get('indent/:id.:format')
  @ApiOperation({ summary: 'Material indent / requisition' })
  async indent(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Param('format') format: string,
    @Res() res: Response,
  ) {
    sendForm(res, await this.documents.indent(caller, id, formatOf(format)));
  }

  @Get('challan/:id.:format')
  @ApiOperation({ summary: 'Material delivery challan, for a stock transfer' })
  async challan(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Param('format') format: string,
    @Res() res: Response,
  ) {
    sendForm(res, await this.documents.challan(caller, id, formatOf(format)));
  }

  @Get('transfer-slip/:id.:format')
  @ApiOperation({ summary: 'Stock transfer slip' })
  async transferSlip(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Param('format') format: string,
    @Res() res: Response,
  ) {
    sendForm(
      res,
      await this.documents.transferSlip(caller, id, formatOf(format)),
    );
  }

  @Get('grn/:id.:format')
  @ApiOperation({ summary: 'Goods receipt note, for a purchase' })
  async grn(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Param('format') format: string,
    @Res() res: Response,
  ) {
    sendForm(res, await this.documents.grn(caller, id, formatOf(format)));
  }

  @Get('issue-slip/:id.:format')
  @ApiOperation({ summary: 'Material issue slip' })
  async issueSlip(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Param('format') format: string,
    @Res() res: Response,
  ) {
    sendForm(res, await this.documents.issueSlip(caller, id, formatOf(format)));
  }

  @Get('daily-issue-register.:format')
  @ApiOperation({
    summary: 'Daily issue register for one store and a span of days',
  })
  async dailyRegister(
    @UserEntity() caller: AuthenticatedUser,
    @Param('format') format: string,
    @Query('siteId') siteId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string | undefined,
    @Query('companyId') companyId: string | undefined,
    @Res() res: Response,
  ) {
    if (!dateFrom) throw new BadRequestException('dateFrom is required');
    sendForm(
      res,
      await this.documents.dailyRegister(
        caller,
        { siteId, dateFrom, dateTo, companyId },
        formatOf(format),
      ),
    );
  }
}
