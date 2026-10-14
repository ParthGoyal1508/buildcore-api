import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Permission, SignedCopySubject } from '@prisma/client';
import type { Response } from 'express';

import { ApprovalService } from '../../../approvals/approvals.service';
import { ENTITY_BILL_PACKAGE } from '../../../approvals/default-chains';
import { AuthenticatedUser } from '../../../auth/authenticated-user';
import { JwtAuthGuard } from '../../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../../common/decorators/permissions.decorator';
import { UserEntity } from '../../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { rlsContextFor } from '../../../common/prisma/rls-context';
import { resolveCompanyId } from '../../../settings/company-scope';
import { ProjectLockGuard } from '../../guards/project-lock.guard';
import { ClientBillsService } from '../client-bills.service';
import { SignedCopiesService } from '../payments/signed-copies.service';
import { BillPackageService } from './bill-package.service';
import { BillPackageViewBuilder } from './bill-package-view.builder';
import { DebitNoteService } from './debit-note.service';
import { SetBillAdjustmentsDto } from './dto/bill-adjustments.dto';
import {
  CertifyBillPackageDto,
  MarkBillSharedDto,
  ReviseBillPackageDto,
  SetBillDeductionLinesDto,
  WithdrawBillPackageDto,
  ReadCertifiedCopyDto,
} from './dto/bill-lifecycle.dto';
import {
  AddNonBoqItemDto,
  SetBillLineClaimDto,
  UpdateNonBoqItemDto,
} from './dto/bill-line.dto';
import { ComposeBillPackageDto } from './dto/compose-bill.dto';
import { RecordDebitDto } from './dto/debit-note.dto';
import { MeasurementSheetService } from './measurement-sheet.service';
import { PackageReportsService } from './package-reports.service';
import { BoqWorkbookReader } from '../../boq/boq-workbook.reader';
import {
  CertifiedCopyReading,
  readCertifiedCopy,
  unreadableCopy,
} from './certified-copy.reader';

const CONTENT_TYPES = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;

/**
 * The running-account bill package (023 US1 to US7).
 *
 * ## Every route carries `PROJECT_FINANCIALS`
 *
 * Not `PROJECTS` (FR-051). A bill is money: somebody who may record a day's work and read a
 * programme is not thereby entitled to see what the company is charging its client or recovering
 * from a subcontractor. 022's reports carry `DWR` for the mirror-image reason.
 *
 * ## `ProjectLockGuard` on every write, returning 423 and not 403
 *
 * The distinction matters to the caller (FR-052): the same person may write the moment the project
 * is unlocked, and a 403 tells them to go and ask for permission they already have.
 *
 * ## Another company's package is 404, not 403
 *
 * A 403 confirms the row exists, which is itself a leak across the boundary row-level security is
 * there to hold (FR-053).
 *
 * ## Registration order is load-bearing
 *
 * These paths are **literals** under `projects/`, and the portfolio registers the parameterised
 * `GET projects/:id`. Nest matches in registration order, so this controller must be listed
 * **before** `ProjectsController` — otherwise every request for a package list arrives at
 * `ProjectsController.findOne` looking for a project whose id is the literal string
 * `bill-packages`, and answers 404 as though the data were missing. `route-shadowing.spec.ts`
 * caught exactly this during 022 and asserts the ordering rather than trusting this comment.
 */
@ApiTags('Projects — running-account bills')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PROJECT_FINANCIALS)
@Controller()
export class BillPackageController {
  constructor(
    private readonly packages: BillPackageService,
    private readonly sheets: MeasurementSheetService,
    private readonly debits: DebitNoteService,
    private readonly reports: PackageReportsService,
    private readonly views: BillPackageViewBuilder,
    private readonly approvals: ApprovalService,
    private readonly clientBills: ClientBillsService,
    private readonly signedCopies: SignedCopiesService,
    private readonly workbooks: BoqWorkbookReader,
  ) {}

  // ── Composition ──────────────────────────────────────────────────────────

  @Post('projects/:projectId/bill-packages')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Open a package for a period and propose every line',
    description:
      'Proposes a claimed quantity for every line of the schedule this direction measures — the ' +
      'project’s BOQ for a bill to a client, that subcontractor’s award lines for a bill to a ' +
      'subcontractor. A line with no measurement to read comes back with a **null** proposal and ' +
      '`no_measurement_source`, which is not the same fact as zero.\n\n' +
      'The same project, direction and period opened twice returns the **existing** package ' +
      'rather than creating a second, because a period billed twice is measurement claimed twice.',
  })
  @ApiResponse({ status: 423, description: 'The project is locked.' })
  async compose(
    @UserEntity() caller: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Body() dto: ComposeBillPackageDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.packages.compose(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      { projectId, ...dto },
    );
  }

  @Post('projects/bill-packages/:packageId/lines/:claimId')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Set one line’s claimed quantity',
    description:
      'A reduction needs a written reason; a claim above the approved measurement needs one too ' +
      'and sets the over-claim flag. Returning the claim to its proposal **clears** the reason — ' +
      'a reason beside a zero variance argues on the measurement sheet for a deduction the bill ' +
      'does not make.',
  })
  async setClaim(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
    @Param('claimId') claimId: string,
    @Body() dto: SetBillLineClaimDto,
  ) {
    return this.packages.setClaim(
      rlsContextFor(caller),
      packageId,
      claimId,
      dto,
    );
  }

  @Post('projects/bill-packages/:packageId/non-boq-items')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Add a non-BOQ item to a draft bill to the client',
    description:
      'Work the tendered BOQ does not list. The item joins the project’s BOQ in its “Non-BOQ ' +
      'items” section (NB-1, NB-2…), so later bills carry it with its quantity up to previous. ' +
      'Billed at `quantity × rate` with no tender premium. A subcontractor’s non-BOQ items go on ' +
      'the work order instead.',
  })
  async addNonBoqItem(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
    @Body() dto: AddNonBoqItemDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.packages.addNonBoqItem(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      packageId,
      dto,
    );
  }

  @Patch('projects/bill-packages/:packageId/non-boq-items/:itemId')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Correct a non-BOQ item’s description, unit or rate',
    description:
      'Refused once an issued bill carries the item: that bill stated it at this rate.',
  })
  async updateNonBoqItem(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateNonBoqItemDto,
  ) {
    return this.packages.updateNonBoqItem(
      rlsContextFor(caller),
      packageId,
      itemId,
      dto,
    );
  }

  @Delete('projects/bill-packages/:packageId/non-boq-items/:itemId')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Remove a non-BOQ item from a draft bill and the project',
    description:
      'Refused when another bill carries it — set its quantity to zero on this bill instead.',
  })
  async removeNonBoqItem(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.packages.removeNonBoqItem(
      rlsContextFor(caller),
      packageId,
      itemId,
    );
  }

  @Patch('projects/bill-packages/:packageId/adjustments')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Set the month’s recoveries, deductions and withholdings',
    description:
      'The figures a person decides, as distinct from the ones a rate produces. Every one of ' +
      'these columns was read by the abstract, printed on the workbook and the PDF, and carried ' +
      'into the next bill’s cumulative position — and **written by nothing**, so each was ' +
      'permanently zero and the bill rendered a *Recovery of Diesel* row that could only ever say ' +
      'nothing.\n\n' +
      '**Omitting a field leaves it unchanged; sending `0` sets it to zero.** A caller that posted ' +
      'the whole set every time would be indistinguishable from one clearing what it did not ' +
      'render.\n\n' +
      '`retentionAmount`, `tdsAmount` and `workDone` are **not accepted**: each is computed from ' +
      'the frozen fractions and the claims, and a bill stating a retention its own rate does not ' +
      'produce is a bill whose arithmetic has stopped being checkable.',
  })
  @ApiResponse({
    status: 409,
    description:
      'The package has been issued. Record it on the next bill — a deduction added after issue is ' +
      'either a change to a signed document or one this bill never made.',
  })
  @ApiResponse({ status: 423, description: 'The project is locked.' })
  async setAdjustments(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
    @Body() dto: SetBillAdjustmentsDto,
  ) {
    return this.packages.setAdjustments(rlsContextFor(caller), packageId, dto);
  }

  @Patch('projects/bill-packages/:packageId/deduction-lines')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Replace a subcontractor bill’s own recovery and deduction lines',
    description:
      'The whole list, every time. Recoveries go in block B, deductions in block C. Each line’s ' +
      'running total is carried to the next bill by its description. Draft only, and refused on a ' +
      'bill to the client, whose payment abstract has no row for a line somebody made up.',
  })
  async setDeductionLines(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
    @Body() dto: SetBillDeductionLinesDto,
  ) {
    return this.packages.setDeductionLines(
      rlsContextFor(caller),
      packageId,
      dto.lines,
    );
  }

  @Post('projects/bill-packages/:packageId/abandon')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Abandon a draft, releasing its period',
    description:
      'The only way out of a mistakenly-opened draft. A package in any status occupies its ' +
      'period, so without this the alternative is deleting the row that records the period was ' +
      'billed — which an issued bill never permits.',
  })
  async abandon(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
  ) {
    await this.packages.abandon(rlsContextFor(caller), packageId);
    return { abandoned: true };
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  @Get('projects/bill-packages/:packageId')
  @ApiOperation({ summary: 'A package and its proposed lines' })
  async findOne(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
    @Query('companyId') companyId?: string,
  ) {
    const view = await this.packages.view(rlsContextFor(caller), packageId);
    const [counterpartyName] = await this.packages.counterpartyNames(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      [view],
    );
    return {
      ...view,
      counterpartyName,
      // The caller's own position in the chain — `canActNow` is what puts the Approve / Reject
      // buttons on the bill itself, for the person whose turn it is.
      approval: await this.approvals.stateOf(
        ENTITY_BILL_PACKAGE,
        packageId,
        caller,
      ),
    };
  }

  @Get('projects/:projectId/bill-packages')
  @ApiOperation({ summary: 'Every package on a project' })
  async list(
    @UserEntity() caller: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Query('companyId') companyId?: string,
  ) {
    const rows = await this.packages.list(rlsContextFor(caller), projectId);
    const names = await this.packages.counterpartyNames(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      rows.map((row) => ({ ...row, projectId })),
    );
    const approvals = await this.approvals.statesOf(
      ENTITY_BILL_PACKAGE,
      rows.map((row) => row.id),
      caller,
    );
    return rows.map((row, index) => ({
      ...row,
      counterpartyName: names[index],
      // Whether the caller is the one this bill is waiting on, so the list can say so.
      awaitingMe: approvals.get(row.id)?.canActNow ?? false,
    }));
  }

  @Get('projects/bill-packages/:packageId/abstract')
  @ApiOperation({
    summary: 'The abstract — four blocks, three columns',
    description:
      'Every figure is rendered to the rupee once, here. A draft’s up-to-date column is marked ' +
      '**provisional**, because the cumulative position is frozen at issue and a figure that ' +
      'changes when the engineer presses Issue is a figure they did not approve.',
  })
  async abstract(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
  ) {
    return this.packages.abstractFor(rlsContextFor(caller), packageId);
  }

  @Get('projects/bill-packages/:packageId/measurement/:scheduleLineId')
  @ApiOperation({
    summary: 'One item’s measurement sheet',
    description:
      'Every period the item has been claimed in, each reason **verbatim**, and the daily record ' +
      'beneath it where the work is a machine running. A date with no logbook entry reads as ' +
      'missing rather than as a run of zeroes.',
  })
  async measurementSheet(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
    @Param('scheduleLineId') scheduleLineId: string,
  ) {
    return this.sheets.sheetFor(
      rlsContextFor(caller),
      packageId,
      scheduleLineId,
    );
  }

  // ── Debits ───────────────────────────────────────────────────────────────

  @Post('projects/:projectId/bill-package-debits')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({ summary: 'Record a debit against a project' })
  async recordDebit(
    @UserEntity() caller: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Body() dto: RecordDebitDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.debits.record(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      caller.id,
      { projectId, ...dto },
    );
  }

  @Post('projects/bill-package-debits/:debitId/apply/:packageId')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Recover a debit on one bill',
    description:
      'A debit is recovered on exactly one bill, and the rule holds under two simultaneous ' +
      'applications — a debit recovered twice is money taken twice. Only a draft accepts one.',
  })
  async applyDebit(
    @UserEntity() caller: AuthenticatedUser,
    @Param('debitId') debitId: string,
    @Param('packageId') packageId: string,
  ) {
    return this.debits.apply(rlsContextFor(caller), debitId, packageId);
  }

  @Get('projects/bill-packages/:packageId/debits')
  @ApiOperation({
    summary: 'The debit register as this bill shows it',
    description:
      'Live for a draft — every debit on the project, because the running total is the point. ' +
      'For an **issued** bill it is the register *as at issue*, so a debit recorded afterwards ' +
      'cannot change a document that has been signed.',
  })
  async register(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
  ) {
    return this.debits.registerFor(rlsContextFor(caller), packageId);
  }

  // ── The workbook ─────────────────────────────────────────────────────────

  @Get('projects/bill-package-debits/:debitId/note.pdf')
  @ApiOperation({
    summary: 'One debit as a standalone note',
    description:
      'The document a subcontractor signs to acknowledge a recovery (028 FR-018). The register ' +
      'already prints inside the package PDF; this is the single-debit note, carrying the number ' +
      'allocated when the debit was raised so the register and the document cannot disagree.\n\n' +
      'Rendered by the **same** renderer as the package PDF, so the letterhead and the columns ' +
      'match the register the figures came from. The subcontractor is named only where the debit ' +
      'has been recovered on one of their bills; until then it is a debit against the project.',
  })
  @ApiResponse({ status: 404, description: 'No such debit in this company.' })
  async debitNote(
    @UserEntity() caller: AuthenticatedUser,
    @Param('debitId') debitId: string,
    @Res() res: Response,
  ): Promise<void> {
    const { bytes, filename } = await this.debits.noteDocumentFor(
      rlsContextFor(caller),
      caller.companyId,
      debitId,
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(bytes);
  }

  @Get('projects/bill-packages/:packageId/document.:format')
  @ApiOperation({
    summary: 'The bill as xlsx, pdf or docx — or its abstract alone',
    description:
      '`format` is `xlsx`, `pdf` or `docx`. `?part=abstract` gives the abstract alone — on a bill ' +
      'to the client, the *Payment Abstract* as its own document. All three formats render from ' +
      'one view, so they cannot disagree.',
  })
  async document(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
    @Param('format') format: string,
    @Res() res: Response,
    @Query('part') part?: string,
  ): Promise<void> {
    if (format !== 'xlsx' && format !== 'pdf' && format !== 'docx') {
      throw new NotFoundException(`No ${format} rendering of a bill.`);
    }
    const { bytes, filename, missingFields } = await this.views.documentFor(
      rlsContextFor(caller),
      packageId,
      format,
      { abstractOnly: part === 'abstract' },
    );
    res.setHeader('Content-Type', CONTENT_TYPES[format]);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (missingFields.length > 0) {
      res.setHeader('X-Bill-Package-Missing-Fields', missingFields.join(','));
    }
    res.send(bytes);
  }

  @Get('projects/bill-packages/:packageId/workbook.xlsx')
  @ApiOperation({
    summary: 'The package as a spreadsheet',
    description:
      'Five sheet kinds in the client’s order, one measurement sheet per schedule line including ' +
      'lines with nothing claimed. Every figure comes from the stored bill and none is recomputed, ' +
      'so the same package downloaded twice is identical in every cell. A missing party ' +
      'identifier is reported in the `X-Bill-Package-Missing-Fields` header, never refused.',
  })
  async workbook(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
    @Res() res: Response,
  ): Promise<void> {
    const { bytes, filename, missingFields } = await this.views.workbookFor(
      rlsContextFor(caller),
      packageId,
    );

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // FR-027a. A workbook is a file download, so a list of gaps recorded on the row and absent
    // from the response is a gap nobody is told about.
    if (missingFields.length > 0) {
      res.setHeader('X-Bill-Package-Missing-Fields', missingFields.join(','));
    }
    res.send(bytes);
  }

  @Get('projects/bill-packages/:packageId/bill.pdf')
  @ApiOperation({
    summary: 'The same package as a PDF',
    description:
      'The same sections in the same order as the workbook — check list, abstract, priced ' +
      'schedule, one measurement sheet per schedule line, debit register — rendered from the ' +
      '**same view**, so the spreadsheet and the PDF of one bill cannot disagree.\n\n' +
      'The `.xlsx` is what a client edits before signing; this is what gets attached to an email, ' +
      'filed and printed. Two readings of one bill, not two bills.\n\n' +
      'A missing party identifier is reported in `X-Bill-Package-Missing-Fields` and prints blank, ' +
      'never refused.',
  })
  async pdf(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
    @Res() res: Response,
  ): Promise<void> {
    const { bytes, filename, missingFields } = await this.views.pdfFor(
      rlsContextFor(caller),
      packageId,
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (missingFields.length > 0) {
      res.setHeader('X-Bill-Package-Missing-Fields', missingFields.join(','));
    }
    res.send(bytes);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  @Post('projects/bill-packages/:packageId/issue')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Issue the bill — freeze every figure and the statutory header',
    description:
      'Refuses an unpriced line carrying a claim: a zero rate is almost always an unpriced line ' +
      'rather than free work, and issuing one bills the work at nothing while the bill looks ' +
      'finished. **Reports, never refuses**: the header fields that could not be filled come ' +
      'back in the response.',
  })
  async issue(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.packages.issue(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      caller.id,
      packageId,
    );
  }

  @Post('projects/bill-packages/:packageId/revise')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Record a revision, with a reason',
    description:
      'What the bill stated when it was issued stays readable. A bill is a document that was ' +
      'sent, and reconciling a payment against a bill whose history has moved is the one thing ' +
      'nobody can do.',
  })
  async revise(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
    @Body() dto: ReviseBillPackageDto,
  ) {
    return this.packages.revise(
      rlsContextFor(caller),
      caller.id,
      packageId,
      dto.reason,
    );
  }

  @Post('projects/bill-packages/:packageId/submit')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Send a draft bill for approval',
    description:
      'Enters the `client_bill` chain for a bill to the client and the `ra_bill` chain for a ' +
      'subcontractor’s, both configured in Settings → Approvals. Refuses what issue would refuse, ' +
      'so an approver never signs a bill that cannot then go out. Locked against edits until the ' +
      'chain finishes or the author withdraws it.',
  })
  async submit(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.packages.submitForApproval(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      caller.id,
      packageId,
    );
  }

  @Post('projects/bill-packages/:packageId/withdraw')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Take a bill back to draft from approval',
    description:
      'Pending or approved but not yet issued. Closes the pending approval; sending it again ' +
      'raises a fresh one, so nobody approves a version that has since changed.',
  })
  async withdraw(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
    @Body() dto: WithdrawBillPackageDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.packages.withdraw(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      packageId,
      dto.reason ?? null,
    );
  }

  @Post('projects/bill-packages/:packageId/share')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary:
      'Record that the issued bill was sent to the client or subcontractor',
  })
  async share(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
    @Body() dto: MarkBillSharedDto,
  ) {
    return this.packages.markShared(
      rlsContextFor(caller),
      caller.id,
      packageId,
      dto.sharedTo ?? null,
    );
  }

  @Post('projects/bill-packages/:packageId/certified-copy/read')
  @ApiOperation({
    summary:
      'Read the client’s certified copy for the quantity passed on each line',
    description:
      '**Writes nothing** (2026-10-15). A bill to the client only. The certified copy — usually ' +
      'the bill’s own workbook with the client’s figures in it — is read for an item-number ' +
      'column and a certified quantity column (headed certified / passed / approved, else this ' +
      'bill, else up-to-date less previous, else a lone Qty column), and its rows matched to the ' +
      'bill’s lines by BOQ item number, then by exact description.\n\n' +
      'Every line that billed anything comes back with `certifiedQty` — `null` where the copy ' +
      'does not mention it — and where it was read from. Rows with a quantity that matched no ' +
      'line are listed in `unmatchedRows`. A PDF, an image, or a workbook nothing could be read ' +
      'from comes back `readable: false` with the reason, and the lines for manual entry. The ' +
      'figures are confirmed on screen and sent to Certify as `lines`. Sent without `data`, the ' +
      'lines alone come back (`readable: false`, `reason: null`), for entering them by hand.',
  })
  async readCertifiedCopy(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
    @Body() dto: ReadCertifiedCopyDto,
  ): Promise<CertifiedCopyReading & { quotedPercentage: number }> {
    const { lines, quotedPercentage } = await this.packages.certifiedCopyLines(
      rlsContextFor(caller),
      packageId,
    );
    // No file: the lines alone, for entering what the client certified by hand.
    if (!dto.data) {
      return { ...unreadableCopy(lines, null), quotedPercentage };
    }
    const data = Buffer.from(dto.data, 'base64');
    const kind = documentKind(data, dto.fileName ?? '');
    if (kind !== 'workbook') {
      return {
        ...unreadableCopy(
          lines,
          kind === 'pdf'
            ? 'A PDF cannot be read for quantities. Enter what the client certified below.'
            : kind === 'image'
            ? 'A photo or scan cannot be read for quantities. Enter what the client certified below.'
            : 'This file is not an Excel workbook, so it cannot be read for quantities. Enter ' +
              'what the client certified below.',
        ),
        quotedPercentage,
      };
    }
    try {
      const sheets = await this.workbooks.read(data);
      return { ...readCertifiedCopy(sheets, lines), quotedPercentage };
    } catch (error) {
      // The reader refuses an oversized, corrupt or empty workbook with a message meant for whoever
      // uploaded it; here that is a reason to enter the figures by hand, not a failed request.
      const message = (error as { response?: { message?: unknown } }).response
        ?.message;
      if (typeof message !== 'string') throw error;
      return {
        ...unreadableCopy(
          lines,
          `${message} Enter what the client certified below.`,
        ),
        quotedPercentage,
      };
    }
  }

  @Post('projects/bill-packages/:packageId/certify')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Certify an issued bill',
    description:
      'On a bill to the client, what the client certified. On a subcontractor’s, the company ' +
      'certifying it — which releases it for payment and for a payment advice. Kept **beside** ' +
      'the billed figure and never instead of it.\n\n' +
      'The certified copy (`certificateData`) is filed for either direction: on a bill to the ' +
      'client as the client bill’s certificate, on a subcontractor’s as a signed copy of its RA ' +
      'bill, received today — which also acknowledges the bill. The returned view’s ' +
      '`certifiedCopy` says which download serves it.',
  })
  async certify(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
    @Body() dto: CertifyBillPackageDto,
  ) {
    const ctx = rlsContextFor(caller);
    const view = await this.packages.certify(ctx, caller.id, packageId, {
      certifiedAmount: dto.certifiedAmount ?? null,
      remarks: dto.remarks ?? null,
      lines: dto.lines ?? null,
    });
    if (!dto.certificateData) return view;

    const file = {
      data: Buffer.from(dto.certificateData, 'base64'),
      fileName: dto.certificateFileName ?? 'certificate',
    };
    // The client's certification document, filed where the client bill has always kept it.
    if (view.clientBillId) {
      await this.clientBills.attachCertificate(ctx, view.clientBillId, file);
    } else if (view.raBillId) {
      // A subcontractor's certified copy (2026-10-14), filed as a **signed copy of the RA bill**
      // rather than in a column of its own: that is where the countersigned bill was always kept,
      // its download already exists, and the first one filed sets `acknowledgedAt` — the state the
      // outstanding views read. Received today, because Certify is the moment it came back.
      await this.signedCopies.upload(
        ctx,
        await this.packages.companyOf(ctx, packageId),
        SignedCopySubject.ra_bill,
        view.raBillId,
        { ...file, receivedOn: new Date().toISOString().slice(0, 10) },
        { userId: caller.id },
      );
    } else {
      return view;
    }
    // Read again, so the response carries the copy just filed.
    return this.packages.view(ctx, packageId);
  }

  // ── The two reports the decisions oblige ─────────────────────────────────

  @Get('projects/:projectId/bill-packages/reports/understatement')
  @ApiOperation({
    summary: 'Issued bills whose period’s measurement has since grown',
    description:
      'This endpoint exists because of the decision to freeze the cumulative position. A report ' +
      'approved after a bill went out belongs to a period already billed, and because measurement ' +
      'is attributed by **work date** it will never appear in any later period’s proposal either ' +
      '— it is unreachable rather than deferred. Each line carries the remedy.',
  })
  async understatement(
    @UserEntity() caller: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.reports.understatement(
      rlsContextFor(caller),
      projectId,
      resolveCompanyId(caller, companyId),
    );
  }

  @Get('projects/:projectId/bill-packages/reports/over-claims')
  @ApiOperation({
    summary: 'Over-claims, per bill and per project, with their denominator',
    description:
      'This endpoint exists because permitting an over-claim with a reason is only safe if the ' +
      'reasons can be read in aggregate. A flag findable only by inspecting lines one at a time ' +
      'is a flag that will not be found.',
  })
  async overClaims(
    @UserEntity() caller: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.reports.overClaims(
      rlsContextFor(caller),
      projectId,
      resolveCompanyId(caller, companyId),
    );
  }
}

/**
 * What a certified copy is, by its first bytes — the extension only where the bytes say nothing
 * (2026-10-15). A renamed file is the common case; see `BoqWorkbookReader`.
 */
function documentKind(
  data: Buffer,
  fileName: string,
): 'workbook' | 'pdf' | 'image' | 'other' {
  const head = data.subarray(0, 8);
  if (head.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (
    head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
    head.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
  ) {
    return 'workbook';
  }
  if (
    head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
    head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ||
    /\.(jpe?g|png|gif|webp|heic|bmp|tiff?)$/i.test(fileName)
  ) {
    return 'image';
  }
  if (/\.pdf$/i.test(fileName)) return 'pdf';
  return 'other';
}
