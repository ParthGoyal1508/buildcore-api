import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { Permission, PayrollRunStatus } from '@prisma/client';
import type { Request, Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { callerFrom } from '../../hr/caller-context';
import { PayrollEngineService } from '../engine/payroll-engine.service';
import { PayrollScheduleService } from './payroll-schedule.service';
import { rlsContextFor } from '../../common/prisma/rls-context';
import { BankSheetService } from './bank-sheet.service';
import { SlipDeliveryService } from './slip-delivery.service';
import { TransactionSheetService } from './transaction-sheet.service';
import { UploadTransactionSheetDto } from './dto/transaction-sheet.dto';
import { PiiCipherService } from '../../hr/employees/pii-cipher.service';
import {
  EditPayrollLineDto,
  GeneratePayrollDto,
  SetRunStatusDto,
} from './dto/generate-payroll.dto';
import { ApprovalService } from '../../approvals/approvals.service';
import { ACTION_PAYROLL_RUN } from '../../approvals/default-chains';
import { contentDispositionFor } from '../../common/storage/file-type';
import { resolveCompanyId } from '../../settings/company-scope';

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
    private readonly transactionSheet: TransactionSheetService,
    /** To match the bank's account numbers against the employees' encrypted ones. */
    private readonly pii: PiiCipherService,
    /** Puts a run processed here into its approval chain (2026-10-17). */
    private readonly schedule: PayrollScheduleService,
    /** 039: each run's approval state, for the runs table and the run screen. */
    private readonly approvals: ApprovalService,
  ) {}

  private companyOf(user: AuthenticatedUser, requested?: string): string {
    // 036 stream 3b (17-10-2026): `resolveCompanyId`, not `user.companyId ?? requested`. The old
    // order let a Super Admin's *home* company win over the one they asked for, and ignored the
    // company selected in the switcher (which arrives on the RLS context, not on `user`), so a
    // Super Admin working in company B read and wrote company A's rows.
    return resolveCompanyId(user, requested);
  }

  @Get()
  @ApiOperation({ summary: 'Payroll runs, newest period first' })
  async list(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query('companyId') companyId?: string,
  ) {
    const runs = await this.engine.list(
      callerFrom(user, request),
      this.companyOf(user, companyId),
    );
    // 039: where each run stands with the Director. The batch read, never one per row.
    const approvals = await this.approvals.statesOf(
      ACTION_PAYROLL_RUN,
      runs.map((r) => r.id),
      user,
    );
    return runs.map((r) => ({ ...r, approval: approvals.get(r.id) ?? null }));
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One run with its computed line items',
    description:
      'Each line carries `editedFields` (039), the columns corrected by hand. `approval` is the ' +
      "run's approval state — level, Director's remarks on a return — or null when never sent. " +
      '`approvalRequired` says whether the company has a payroll chain, so processing needs it.',
  })
  async getRun(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
  ) {
    const run = await this.engine.getRun(callerFrom(user, request), id);
    const [approval, approvalRequired] = await Promise.all([
      this.approvals.stateOf(ACTION_PAYROLL_RUN, id, user),
      this.engine.approvalRequired(run.companyId),
    ]);
    return { ...run, approval, approvalRequired };
  }

  @Patch(':id/lines/:lineId')
  @ApiOperation({
    summary: 'Correct one generated line by hand, with a justification (039)',
    description:
      'Only while the run is a draft that is not with the Director and not approved — never ' +
      'sent, or returned. One history row per changed figure; net pay is recomputed. Refusals: ' +
      '409 `PAYROLL_RUN_NOT_DRAFT`, `PAYROLL_RUN_AWAITING_APPROVAL`, `PAYROLL_RUN_ALREADY_APPROVED`, ' +
      '`PAYROLL_FNF_NOT_EDITABLE`; 400 `PAYROLL_EDIT_FIELD_NOT_EDITABLE`, ' +
      '`PAYROLL_EDIT_INVALID_AMOUNT`, `PAYROLL_EDIT_NO_CHANGE`, `PAYROLL_EDIT_NET_NEGATIVE`, ' +
      '`PAYROLL_EDIT_BELOW_REIMBURSEMENT`, `PAYROLL_EDIT_JUSTIFICATION_REQUIRED`.',
  })
  async editLine(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: EditPayrollLineDto,
  ) {
    return this.engine.editLine(
      callerFrom(user, request),
      id,
      lineId,
      dto.changes,
      dto.justification,
    );
  }

  @Get(':id/edits')
  @ApiOperation({
    summary: 'Hand corrections on a run, newest first (039)',
    description:
      'Who changed which figure, old → new, why and when. `lineItemId` narrows it to one line.',
  })
  async lineEdits(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
    @Query('lineItemId') lineItemId?: string,
  ) {
    return this.engine.lineEdits(callerFrom(user, request), id, lineItemId);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Discard a Draft run (036 F9)',
    description:
      'For a draft generated by mistake — wrong period, or before attendance was in. A draft ' +
      'moves no balances (036 F1/F2), so discarding it undoes nothing but its lines. A processed ' +
      'or paid run refuses with 409 `PAYROLL_RUN_NOT_DRAFT`.',
  })
  async discardDraft(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
  ): Promise<void> {
    await this.engine.discardDraft(callerFrom(user, request), id);
  }

  @Post()
  @ApiOperation({
    summary: 'Generate a Draft payroll run',
    description:
      'Computes one line per active employee in a single transaction. ' +
      'Regenerating a Draft replaces its lines; a Processed or Paid run refuses. 039: a draft ' +
      'with the Director or approved refuses (`PAYROLL_RUN_AWAITING_APPROVAL`, ' +
      '`PAYROLL_RUN_ALREADY_APPROVED`), and one with hand corrections refuses with ' +
      '`PAYROLL_RUN_HAS_EDITS` unless `discardEdits` is true.',
  })
  @ApiResponse({
    status: 409,
    description:
      'That period is already processed or paid, is with the Director, or has hand edits.',
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
      { discardEdits: dto.discardEdits === true },
    );
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Advance a run: draft → processed → paid',
    description:
      'Processing freezes the figures (FR-015) and settles the loan schedule ' +
      'entries the run deducted. Neither transition is reversible. 039: processing a regular run ' +
      "needs the Director's approval first — 409 `PAYROLL_RUN_NOT_SUBMITTED`, " +
      '`PAYROLL_RUN_NOT_APPROVED` or `PAYROLL_RUN_RETURNED` otherwise.',
  })
  @ApiResponse({ status: 409, description: 'Transition not permitted.' })
  async setStatus(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: SetRunStatusDto,
  ) {
    const caller = callerFrom(user, request);
    const result = await this.engine.setStatus(caller, id, dto.status);
    if (result.status === PayrollRunStatus.processed) {
      // 2026-10-17, narrowed by 039: a regular run is approved before it can be processed, so this
      // finds its chain and does nothing. An F&F run is still approved after processing, and this
      // is what puts it in front of an approver. A missing chain does not undo the processing.
      const run = await this.engine.getRun(caller, id);
      await this.schedule
        .submitIfNeverSubmitted(run.companyId, id, user.id)
        .catch(() => undefined);
    }
    return result;
  }

  @Post(':id/submit-for-approval')
  @ApiOperation({
    summary: 'Send the run to the Director for approval (039)',
    description:
      "HR's explicit step after reviewing and correcting the draft; the sender is recorded as " +
      'the originator, so a returned run can be sent again. Also sends an older processed run that ' +
      'never entered a chain. 409 `PAYROLL_RUN_AWAITING_APPROVAL` when already with the Director, ' +
      '`PAYROLL_RUN_ALREADY_APPROVED`, `PAYROLL_RUN_ALREADY_PAID`, or ' +
      '`APPROVAL_CHAIN_NOT_CONFIGURED`.',
  })
  async submitForApproval(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
  ) {
    const run = await this.engine.getRun(callerFrom(user, request), id);
    const approval = await this.schedule.sendToDirector(
      run.companyId,
      id,
      user,
    );
    return { runId: id, submitted: true, approval };
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

  @Post(':id/transaction-sheet')
  @ApiOperation({
    summary:
      'Upload the bank’s returned transaction sheet and reconcile it (FR-008 to FR-011)',
    description:
      '**An unparseable row uploads and is reported; the file does not fail.** A parser that ' +
      'refuses on the first unrecognised row reports nothing at all, which is the opposite of ' +
      'what is wanted when a bank has changed a column and somebody needs to know which rows ' +
      'still line up. The upload succeeds and the *reconciliation* is what is incomplete.\n\n' +
      'The one refusal is a file that cannot be opened as a workbook — there the remedy is a ' +
      'different file, not a report.\n\n' +
      'Matching is on the **account number**, never the beneficiary name: the name is whatever ' +
      'the beneficiary’s own bank holds, and in the client’s sample it is misspelled against ' +
      'every HR record.\n\n' +
      'Lines in the sheet matching no employee and employees with no line in the sheet are ' +
      'reported **separately**. The first is money that moved to somebody the run does not know ' +
      'about; the second is money that did not move. They need different people to look at them.',
  })
  @ApiResponse({
    status: 400,
    description: 'The file could not be opened as a spreadsheet.',
  })
  async uploadTransactionSheet(
    @UserEntity() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UploadTransactionSheetDto,
  ) {
    const lines = await this.transactionSheet.parse(
      Buffer.from(dto.data, 'base64'),
    );
    return this.transactionSheet.reconcile(
      rlsContextFor(user),
      id,
      lines,
      (value) => this.pii.decrypt(value),
    );
  }

  /**
   * 036 F11. Generating the run's bank sheet records advance recoveries and a history entry, so it
   * is a `POST`. The old mutating `GET` was removed in Wave 3 (stream 3b) once the web app posted;
   * re-download a past sheet from `hr/payroll/bank-sheet/history/:id/file`.
   */
  @Post(':id/bank-sheet')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Generate the bank transfer sheet for the run (XLSX)',
    description:
      'One row per employee with a recorded bank account. Employees without ' +
      'one are reported in a second sheet rather than silently dropped. Records ' +
      'advance recoveries against the transfer and a history entry.',
  })
  async generateBankSheet(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
    @Res() response: Response,
  ): Promise<void> {
    return this.bankSheetExport(user, request, id, response);
  }

  private async bankSheetExport(
    user: AuthenticatedUser,
    request: Request,
    id: string,
    response: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.bankSheet.build(
      callerFrom(user, request),
      id,
    );
    response.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader('Content-Disposition', contentDispositionFor(filename));
    response.send(buffer);
  }
}
