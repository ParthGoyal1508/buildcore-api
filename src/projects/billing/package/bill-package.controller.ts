import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Response } from 'express';

import { AuthenticatedUser } from '../../../auth/authenticated-user';
import { JwtAuthGuard } from '../../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../../common/decorators/permissions.decorator';
import { UserEntity } from '../../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { rlsContextFor } from '../../../common/prisma/rls-context';
import { resolveCompanyId } from '../../../settings/company-scope';
import { ProjectLockGuard } from '../../guards/project-lock.guard';
import { BillPackageService } from './bill-package.service';
import { BillPackageViewBuilder } from './bill-package-view.builder';
import { DebitNoteService } from './debit-note.service';
import { SetBillLineClaimDto } from './dto/bill-line.dto';
import { SetCheckListDto } from './dto/check-list.dto';
import { ComposeBillPackageDto } from './dto/compose-bill.dto';
import { RecordDebitDto } from './dto/debit-note.dto';
import { MeasurementSheetService } from './measurement-sheet.service';
import { PackageReportsService } from './package-reports.service';

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
  ) {
    return this.packages.view(rlsContextFor(caller), packageId);
  }

  @Get('projects/:projectId/bill-packages')
  @ApiOperation({ summary: 'Every package on a project' })
  async list(
    @UserEntity() caller: AuthenticatedUser,
    @Param('projectId') projectId: string,
  ) {
    return this.packages.list(rlsContextFor(caller), projectId);
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

  @Get('projects/bill-packages/:packageId/check-list')
  @ApiOperation({ summary: 'The six check-list questions and their answers' })
  async checkList(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
  ) {
    return this.packages.checkListFor(rlsContextFor(caller), packageId);
  }

  @Post('projects/bill-packages/:packageId/check-list')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Answer the check list',
    description:
      'An answer may be omitted, which leaves the question unanswered — not answered no. Nothing ' +
      'here ever refuses an issue.',
  })
  async setCheckList(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
    @Body() dto: SetCheckListDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.packages.setCheckList(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      caller.id,
      packageId,
      dto.answers,
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
      'finished. **Reports, never refuses**: the header fields that could not be filled and the ' +
      'check-list gaps come back in the response.',
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
    @Body() body: { reason: string },
  ) {
    return this.packages.revise(
      rlsContextFor(caller),
      caller.id,
      packageId,
      body.reason,
    );
  }

  @Post('projects/bill-packages/:packageId/certify')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Record what the counterparty certified',
    description:
      'Kept **beside** the billed figure and never instead of it. The variance between the two is ' +
      'what a project manager chases, and overwriting the billed amount erases the fact that ' +
      'there was a shortfall at all.',
  })
  async certify(
    @UserEntity() caller: AuthenticatedUser,
    @Param('packageId') packageId: string,
    @Body() body: { certifiedAmount: string },
  ) {
    return this.packages.certify(
      rlsContextFor(caller),
      packageId,
      body.certifiedAmount,
    );
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
  ) {
    return this.reports.understatement(rlsContextFor(caller), projectId);
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
  ) {
    return this.reports.overClaims(rlsContextFor(caller), projectId);
  }
}
