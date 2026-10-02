import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Request, Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { callerFrom } from '../../hr/caller-context';
import { PayrollEngineService } from '../engine/payroll-engine.service';
import { rlsContextFor } from '../../common/prisma/rls-context';
import { BankSheetService } from './bank-sheet.service';
import { SlipDeliveryService } from './slip-delivery.service';
import {
  GeneratePayrollDto,
  SetRunStatusDto,
} from './dto/generate-payroll.dto';

/** Payroll run lifecycle and exports (005 US5). */
@ApiTags('HR — Payroll')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PAYROLL)
@Controller('hr/payroll/runs')
export class PayrollRunsController {
  constructor(
    private readonly engine: PayrollEngineService,
    private readonly bankSheet: BankSheetService,
    private readonly slips: SlipDeliveryService,
  ) {}

  private companyOf(user: AuthenticatedUser, requested?: string): string {
    const companyId = user.companyId ?? requested;
    if (!companyId) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }
    return companyId;
  }

  @Get()
  @ApiOperation({ summary: 'Payroll runs, newest period first' })
  async list(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query('companyId') companyId?: string,
  ) {
    return this.engine.list(
      callerFrom(user, request),
      this.companyOf(user, companyId),
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'One run with its computed line items' })
  async getRun(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
  ) {
    return this.engine.getRun(callerFrom(user, request), id);
  }

  @Post()
  @ApiOperation({
    summary: 'Generate a Draft payroll run',
    description:
      'Computes one line per active employee in a single transaction. ' +
      'Regenerating a Draft replaces its lines; a Processed or Paid run refuses.',
  })
  @ApiResponse({
    status: 409,
    description: 'That period is already processed or paid.',
  })
  async generate(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Body() dto: GeneratePayrollDto,
  ) {
    return this.engine.generate(
      callerFrom(user, request),
      this.companyOf(user, dto.companyId),
      dto.period,
    );
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Advance a run: draft → processed → paid',
    description:
      'Processing freezes the figures (FR-015) and settles the loan schedule ' +
      'entries the run deducted. Neither transition is reversible.',
  })
  @ApiResponse({ status: 409, description: 'Transition not permitted.' })
  async setStatus(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: SetRunStatusDto,
  ) {
    return this.engine.setStatus(callerFrom(user, request), id, dto.status);
  }

  @Get(':id/slip-deliveries')
  @ApiOperation({
    summary: 'Who has been emailed their payslip for this run (FR-006)',
    description:
      'Delivered, failed and undeliverable, each as its own count and its own rows. ' +
      '**Undeliverable is not a kind of failure**: a failure is retried, an undeliverable ' +
      'row needs somebody to find an address first, and a retry that swept up both would ' +
      'keep failing on the same employees forever.\n\n' +
      'Each row carries the address **as sent**. An employee whose email was corrected after ' +
      'a failure must not have the old failure read as though it went to the new address.',
  })
  async slipDeliveries(
    @UserEntity() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.slips.report(rlsContextFor(user), id);
  }

  @Post(':id/slip-deliveries')
  @ApiOperation({
    summary:
      'Email this run’s payslips to the employees they belong to (FR-005)',
    description:
      'An **explicit** action rather than an automatic one. FR-005 reads as automatic delivery ' +
      'on payment and the client asked us to check that; until they answer, this is the control, ' +
      'because an explicit send can be automated later whereas an automatic send that was wrong ' +
      'has already emailed five hundred people their salary.\n\n' +
      'Skips anybody already sent to, so pressing it twice does not send twice — which matters, ' +
      'because the first press takes minutes for a full company.\n\n' +
      'Refuses a run whose approval chain is incomplete (FR-007).',
  })
  @ApiResponse({
    status: 409,
    description: 'The run is not fully approved, naming the level it waits on.',
  })
  async sendSlips(
    @UserEntity() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.slips.send(rlsContextFor(user), id);
  }

  @Post(':id/slip-deliveries/retry')
  @ApiOperation({
    summary: 'Resend only the failures (FR-006)',
    description:
      'Only `failed` rows, selected as a query rather than filtered from everybody — the ' +
      'difference between twelve emails and five hundred must not rest on a filter staying ' +
      'correct. Undeliverable rows are deliberately untouched: they have no address, so a retry ' +
      'would fail identically every time.',
  })
  async retrySlips(
    @UserEntity() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.slips.retry(rlsContextFor(user), id);
  }

  @Get(':id/bank-sheet')
  @ApiOperation({
    summary: 'Bank transfer sheet for the run (XLSX)',
    description:
      'One row per employee with a recorded bank account. Employees without ' +
      'one are reported in a second sheet rather than silently dropped.',
  })
  async bankSheetExport(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
    @Res() response: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.bankSheet.build(
      callerFrom(user, request),
      id,
    );
    response.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );
    response.send(buffer);
  }
}
