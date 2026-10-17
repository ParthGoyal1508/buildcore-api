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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { rlsContextFor } from '../../common/prisma/rls-context';
import { resolveCompanyId } from '../../settings/company-scope';
import { ClientBillsService } from './client-bills.service';
import { CertifyBillDto, ComposeBillDto } from './dto/client-bill.dto';
import {
  ProjectLockFrom,
  ProjectLockGuard,
} from '../guards/project-lock.guard';
import { listPaging } from '../list-paging';

/**
 * Client bills measured against the BOQ (018 US1) — `bugs.md` item 11.
 *
 * `PROJECT_FINANCIALS`, not `PROJECTS`. A bill is money leaving or arriving on a contract, and the
 * enum has carried a separate value for a project's financials since 002 reserved it — gating this on
 * the permission that opens the project list would hand every site engineer the billing surface.
 */
@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PROJECT_FINANCIALS)
@Controller('projects/client-bills')
export class ClientBillsController {
  constructor(private readonly bills: ClientBillsService) {}

  @Get()
  @ApiOperation({
    summary: 'Every client bill on a project, newest first',
    description:
      'Each bill carries its lines with the **cumulative position as at its own billing date** — ' +
      'opening a bill from last quarter shows the running total as it stood then, not today’s, ' +
      'because today’s beside figures from then reads as an arithmetic error in the bill.',
  })
  async list(
    @UserEntity() caller: AuthenticatedUser,
    @Query('projectId') projectId: string,
    // 036 I26: no page params → the bare array as before (capped); either → `{ items, total, … }`.
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.bills.listForProject(
      rlsContextFor(caller),
      projectId,
      listPaging(page, pageSize),
    );
  }

  /**
   * **Declared before `@Get(':id')` on purpose.** Nest matches routes in registration order, so with
   * the parameterised route first this literal path would be answered as "bill boq not found" — a
   * data problem to look at, when it is a routing one. The projects module header carries the same
   * note about `/projects/document-requirements` for the same reason.
   */
  @Get('boq')
  @ApiOperation({
    summary:
      'The project’s BOQ, priced and positioned, ready to measure (FR-001)',
    description:
      'Headings and their lines, because a BOQ is **two levels**: a heading carries no quantity and ' +
      'no rate here, so a sheet cannot render it as a measured line of zero. The client’s own file ' +
      'is 80 heading rows across 311 schedule rows — measured through the parser on 2026-10-03, ' +
      'replacing the earlier estimate of 83 across 312 — and a flat list cannot represent it.\n\n' +
      '**Two totals, not one, and they are computed differently from a bill’s on purpose.** ' +
      '`estimatedTotal` is the schedule at its own rates; `quotedTotal` is that figure with the ' +
      'bidder’s percentage applied **once, to the total**, which is how the tender document states ' +
      'it and what the BOQ import reconciles against. A **bill** applies the percentage per line and ' +
      'sums the printed lines, because the total on a document a client reads must equal the column ' +
      'above it. Both are right for their own document and they differ by rounding — at most half a ' +
      'paisa a line; `test/client-bills.e2e-spec.ts` measures the divergence rather than pretending ' +
      'it is zero. Neither comment should be read as calling the other wrong.\n\n' +
      'Lines belonging to the project’s internal **estimate** are excluded entirely (008 US4 AC6): ' +
      'an estimate is costed at your own rates, and offering it here would present it as billable ' +
      'scope.\n\n' +
      '`unpriced` marks a line whose rate is still 0, so the sheet can say so **before** somebody ' +
      'fills a column and meets `BOQ_RATE_MISSING` at submit.',
  })
  async boq(
    @UserEntity() caller: AuthenticatedUser,
    @Query('projectId') projectId: string,
  ) {
    return this.bills.billableBoq(rlsContextFor(caller), projectId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One bill with its measured lines' })
  async view(@UserEntity() caller: AuthenticatedUser, @Param('id') id: string) {
    return this.bills.view(rlsContextFor(caller), id);
  }

  @Post()
  @UseGuards(ProjectLockGuard)
  @ProjectLockFrom('body')
  @ApiOperation({
    summary: 'Compose a draft bill, priced from the BOQ (FR-002)',
    description:
      'Reads each BOQ rate **once** and freezes it onto the line, along with the project’s quoted ' +
      'percentage. Revise the BOQ afterwards and a submitted bill does not move — a bill is a ' +
      'document that was sent, and rendering it from a live rate table makes every historical bill a ' +
      'lie that changes shape.\n\n' +
      'A line measuring past its BOQ scope is **flagged, not refused** (FR-003). The refusal is at ' +
      'submit, and only without a reason.',
  })
  @ApiResponse({
    status: 400,
    description:
      '`BOQ_RATE_MISSING` naming the unpriced lines, or `BOQ_REQUIRED` when the project has no BOQ.',
  })
  @ApiResponse({ status: 409, description: '`BILL_NUMBER_IN_USE`.' })
  async compose(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: ComposeBillDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.bills.compose(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      dto,
    );
  }

  @Post(':id/submit')
  @UseGuards(ProjectLockGuard)
  @ProjectLockFrom('clientBill')
  @ApiOperation({
    summary: 'Send the bill to the client',
    description:
      'Refuses an over-scope line with no reason, **naming the lines** — "some lines exceed scope" ' +
      'sends somebody scanning three hundred rows for the ones that do.',
  })
  @ApiResponse({
    status: 400,
    description: '`OVER_SCOPE_REASON_REQUIRED`, with the BOQ numbers.',
  })
  async submit(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.bills.submit(rlsContextFor(caller), id);
  }

  @Post(':id/certify')
  @UseGuards(ProjectLockGuard)
  @ProjectLockFrom('clientBill')
  @ApiOperation({
    summary: 'Record what the client certified (FR-005)',
    description:
      '**Billed figures are kept.** The billed amount and each line’s billed quantity are not ' +
      'overwritten: a shortfall is a dispute to pursue, not a correction to absorb, and a system ' +
      'that silently reduced what was billed would lose the only record that there was one.\n\n' +
      '**Certify line by line to free the uncertified quantity (2026-10-11).** Nine items billed ' +
      'and eight certified used to leave all nine deducted from the outstanding BOQ, so the ninth ' +
      'could not be claimed again without over-measuring. Send `lines` and only what was certified ' +
      'counts against the schedule.\n\n' +
      'Re-certifying is how a certification is corrected: the endpoint accepts an already-certified ' +
      'bill and replaces what it holds, certificate included.',
  })
  @ApiResponse({
    status: 400,
    description:
      '`CERTIFIED_EXCEEDS_BILLED` — more likely a typo than a windfall.',
  })
  async certify(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CertifyBillDto,
  ) {
    return this.bills.certify(rlsContextFor(caller), id, {
      certifiedAmount: dto.certifiedAmount,
      lines: dto.lines,
      ...(dto.certificateData
        ? {
            certificate: {
              data: Buffer.from(dto.certificateData, 'base64'),
              // Falls back to a name rather than refusing: a certificate that arrived
              // with no file name is still the document, and a 400 here would lose it.
              fileName: dto.certificateFileName ?? 'certificate',
            },
          }
        : {}),
    });
  }

  @Get(':id/certificate')
  @ApiOperation({
    summary: 'Download the client’s certification document (2026-10-11)',
    description:
      'Addressed by the **bill’s** id, never the storage reference: a reference on the wire is a ' +
      'handle to bytes, and an endpoint that took one would serve any blob whose ref a caller had ' +
      'once been shown.',
  })
  @ApiResponse({
    status: 404,
    description: 'No certification document on this bill.',
  })
  async certificate(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { bytes, mimeType, contentDisposition } =
      await this.bills.readCertificate(rlsContextFor(caller), id);
    // The real type: a browser cannot render what it has not been told, and serving a
    // PDF as octet-stream is how one ends up opened in a text editor.
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', contentDisposition);
    // Without this a cross-origin caller cannot read the name off a `fetch`, and a blob
    // URL carries none of its own.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.status(200).send(bytes);
  }
}
