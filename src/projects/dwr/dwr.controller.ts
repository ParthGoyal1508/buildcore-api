import {
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  Post,
  Patch,
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
import { ProjectLockGuard } from '../guards/project-lock.guard';
import { DwrPeriodFiguresService } from './dwr-period-figures.service';
import { DwrService } from './dwr.service';
import { CreateDwrDto } from './dto/create-dwr.dto';
import {
  AddDwrAttachmentDto,
  RepairDoneQtyDto,
  ReverseDwrDto,
} from './dto/dwr-lifecycle.dto';
import { DwrPeriodDto, ListDwrDto } from './dto/dwr-query.dto';
import { UpdateDwrDto } from './dto/update-dwr.dto';

/**
 * Daily work reports (022 — 008 User Story 5, built two months late).
 *
 * `Permission.DWR` rather than `PROJECTS`: 008 added the value in August and seeded it into roles,
 * and until this controller existed nothing guarded it. A site supervisor who records the day's
 * work does not thereby need the project portfolio, and an office administrator who maintains the
 * portfolio does not thereby certify measurement.
 *
 * `ProjectLockGuard` on every write. A frozen project is exactly where a late report would
 * otherwise still move executed quantities — and the refusal is **423, not 403**, because the
 * distinction matters to the caller: the same person may write the moment the project is unlocked.
 *
 * Another company's report is **404, not 403** (FR-029). A 403 confirms the row exists, which is
 * itself a leak across the boundary row-level security is there to hold.
 */
@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.DWR)
@Controller()
export class DwrController {
  constructor(
    private readonly dwr: DwrService,
    private readonly figures: DwrPeriodFiguresService,
  ) {}

  // ── Recording ────────────────────────────────────────────────────────────

  @Post('projects/:projectId/dwr')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Record a day’s work',
    description:
      'Every quantity is computed by the server. A measured line’s quantity is the product of ' +
      'its six factors; a presence-paid line’s is the day served. Neither shape accepts a ' +
      'computed quantity — there is no field for one, which is a stronger guarantee than ' +
      'overriding what a caller sends.\n\n' +
      '**Three things are reported rather than refused**, and each would be tempting to refuse: ' +
      'a work date before the project started (a start date corrected late is far more common ' +
      'than invented work), a second report for a day already covered (two crews on two ' +
      'stretches is ordinary, and refusing the second loses it), and a line past its BOQ scope ' +
      '(the site did the work). They come back in `warnings` beside a 201.',
  })
  @ApiResponse({ status: 423, description: 'The project is locked.' })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Body() dto: CreateDwrDto,
    @Ip() ip: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.dwr.create(
      rlsContextFor(caller),
      projectId,
      resolveCompanyId(caller, companyId),
      dto,
      { userId: caller.id, ipAddress: ip },
    );
  }

  @Patch('projects/dwr/:dwrId')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Edit a draft',
    description:
      'An approved report is refused, and the message names the reversal path. Approving it ' +
      'moved executed quantities a bill may already have been built from, so an edit would move ' +
      'those figures with nothing recording that they moved.',
  })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('dwrId') dwrId: string,
    @Body() dto: UpdateDwrDto,
    @Ip() ip: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.dwr.update(
      rlsContextFor(caller),
      dwrId,
      resolveCompanyId(caller, companyId),
      dto,
      { userId: caller.id, ipAddress: ip },
    );
  }

  @Post('projects/dwr/:dwrId/attachments')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Attach a file to a report',
    description:
      'The content type is detected from the **bytes**, never taken from the caller’s claim, and ' +
      'the file name is stored as the uploader spelled it — so the download arrives named and ' +
      'openable rather than as a bare reference.',
  })
  async addAttachment(
    @UserEntity() caller: AuthenticatedUser,
    @Param('dwrId') dwrId: string,
    @Body() dto: AddDwrAttachmentDto,
    @Ip() ip: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.dwr.addAttachment(
      rlsContextFor(caller),
      dwrId,
      resolveCompanyId(caller, companyId),
      { data: Buffer.from(dto.data, 'base64'), fileName: dto.fileName },
      { userId: caller.id, ipAddress: ip },
    );
  }

  @Get('projects/dwr/attachments/:attachmentId')
  @ApiOperation({ summary: 'Download an attachment' })
  async downloadAttachment(
    @UserEntity() caller: AuthenticatedUser,
    @Param('attachmentId') attachmentId: string,
    @Res() res: Response,
  ) {
    const { data, mimeType, contentDisposition } =
      await this.dwr.readAttachment(rlsContextFor(caller), attachmentId);

    // The real type, not `application/octet-stream`: a browser cannot render what it has not been
    // told, and serving every attachment as opaque bytes is why a PDF once opened in a text editor.
    res.setHeader('Content-Type', mimeType);
    // Built by `contentDispositionFor`, never from the raw name — a file name is typed by a person,
    // and `setHeader` throws `ERR_INVALID_CHAR` on any byte outside latin1, which is a 500 on a
    // download rather than a mangled name.
    res.setHeader('Content-Disposition', contentDisposition);
    // Without this a cross-origin caller cannot read the header off a `fetch`, and the name is the
    // only place it exists — a blob URL carries none of its own.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(data);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  @Post('projects/dwr/:dwrId/submit')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Put a report forward for review',
    description:
      'Moves **no** executed quantity. A submission is a claim, not a fact; counting it as ' +
      'progress is what makes a BOQ disagree with the site.',
  })
  async submit(
    @UserEntity() caller: AuthenticatedUser,
    @Param('dwrId') dwrId: string,
    @Ip() ip: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.dwr.submit(
      rlsContextFor(caller),
      dwrId,
      resolveCompanyId(caller, companyId),
      { userId: caller.id, ipAddress: ip },
    );
  }

  @Post('projects/dwr/:dwrId/approve')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Approve a report, and move the project’s executed quantities',
    description:
      'The only path in the system that increases a BOQ line’s executed quantity.\n\n' +
      '**Every one of a report’s increments or none**, in one transaction. **At most once**, ' +
      'however many times this is called and even from two requests at the same instant. And ' +
      '**not by the person who submitted it** — approval is a direct transition rather than a ' +
      'routed chain, because one report a day per project makes routing disproportionate, so ' +
      'segregation of duty is the control that remains.',
  })
  @ApiResponse({ status: 403, description: 'You submitted this report.' })
  @ApiResponse({
    status: 409,
    description: 'Already approved, or not submitted.',
  })
  async approve(
    @UserEntity() caller: AuthenticatedUser,
    @Param('dwrId') dwrId: string,
    @Ip() ip: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.dwr.approve(
      rlsContextFor(caller),
      dwrId,
      resolveCompanyId(caller, companyId),
      { userId: caller.id, ipAddress: ip },
    );
  }

  @Post('projects/dwr/:dwrId/return')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Send a submitted report back to draft',
    description: 'Nothing moves, because submission never moved anything.',
  })
  async returnToDraft(
    @UserEntity() caller: AuthenticatedUser,
    @Param('dwrId') dwrId: string,
    @Ip() ip: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.dwr.returnToDraft(
      rlsContextFor(caller),
      dwrId,
      resolveCompanyId(caller, companyId),
      { userId: caller.id, ipAddress: ip },
    );
  }

  @Post('projects/dwr/:dwrId/reverse')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Undo an approval, taking its quantities back out',
    description:
      'Subtracts **exactly** what the approval added — the quantities stored on the lines, not ' +
      'recomputed from their factors, which may have been edited since.\n\n' +
      'Refused when it would leave a BOQ line with less executed quantity than has already been ' +
      'billed against it on a bill that has left draft. That checks the **totals**, not which ' +
      'bill line consumed which report: nothing in the data records that, so it cannot be ' +
      'checked, and the refusal says so rather than implying otherwise.',
  })
  @ApiResponse({
    status: 409,
    description: 'Already billed past this point, or not approved.',
  })
  async reverse(
    @UserEntity() caller: AuthenticatedUser,
    @Param('dwrId') dwrId: string,
    @Body() dto: ReverseDwrDto,
    @Ip() ip: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.dwr.reverse(
      rlsContextFor(caller),
      dwrId,
      resolveCompanyId(caller, companyId),
      dto,
      { userId: caller.id, ipAddress: ip },
    );
  }

  @Delete('projects/dwr/:dwrId')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Delete a draft',
    description:
      'Drafts only. An approved report is reversed first, with a reason.',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('dwrId') dwrId: string,
    @Ip() ip: string,
    @Query('companyId') companyId?: string,
  ) {
    await this.dwr.remove(
      rlsContextFor(caller),
      dwrId,
      resolveCompanyId(caller, companyId),
      { userId: caller.id, ipAddress: ip },
    );
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  @Get('projects/dwr')
  @ApiOperation({
    summary: 'A project’s reports, filtered and paginated',
    description:
      'The total comes from a separate count over the same filter, so it does not depend on the ' +
      'page returned — a total equal to the page length is how a list tells a reader there are ' +
      '25 reports when there are 300.',
  })
  async list(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListDwrDto,
  ) {
    return this.dwr.list(rlsContextFor(caller), query);
  }

  @Get('projects/dwr/:dwrId')
  @ApiOperation({
    summary: 'One report, with each line’s BOQ position and logbook evidence',
    description:
      'Where a line names a piece of equipment, its logbook entry for the work date comes with ' +
      'it — the odometer register the client’s measurement sheets print beneath each item, read ' +
      'from the plant module across its own boundary and never copied into this one.\n\n' +
      'A date the equipment has no entry for is reported as **missing**, never as a run of zero: ' +
      'an unrecorded day and a day the machine did nothing are different facts.',
  })
  async findOne(
    @UserEntity() caller: AuthenticatedUser,
    @Param('dwrId') dwrId: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.dwr.findOne(
      rlsContextFor(caller),
      dwrId,
      resolveCompanyId(caller, companyId),
    );
  }

  // ── The contract to feature 023 ──────────────────────────────────────────

  @Get('projects/:projectId/dwr/period-figures')
  @ApiOperation({
    summary: 'Approved measurement per BOQ line, for one billing period',
    description:
      'The three columns every sheet of a running-account bill is built from: *This Month*, ' +
      '*Upto Previous* and *Upto Date*.\n\n' +
      'Only **approved** reports count. Measurement is attributed by **work date**, never by ' +
      'approval date — a report for 21 December approved on 5 January belongs to December, or ' +
      'December’s bill is short by it and January’s claims work done before its period began.\n\n' +
      '**Every BOQ line in the project is returned**, including lines nobody has measured, ' +
      'carrying zeros. A line absent from this response and a line that measured nothing are ' +
      'indistinguishable to the caller, and the caller is a bill.',
  })
  @ApiResponse({
    status: 400,
    description: 'The period ends before it begins.',
  })
  async periodFigures(
    @UserEntity() caller: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Query() range: DwrPeriodDto,
  ) {
    return this.figures.figuresFor(rlsContextFor(caller), projectId, range);
  }

  @Get('projects/:projectId/dwr/reconciliation')
  @ApiOperation({
    summary:
      'Where the stored executed quantity disagrees with the approved measurement',
    description:
      'At an **exact** tolerance: both figures are decimal to three places and every increment ' +
      'is exact, so any non-zero difference is a defect rather than rounding.\n\n' +
      'The sum of approved measurement is authoritative and the stored counter is a cache of it. ' +
      'This is the only thing in the system that can say the counter is wrong, and a ' +
      'denormalised total with no way to check it is a total whose drift is found at a month-end.',
  })
  async reconciliation(
    @UserEntity() caller: AuthenticatedUser,
    @Param('projectId') projectId: string,
  ) {
    return this.figures.reconcile(rlsContextFor(caller), projectId);
  }

  @Post('projects/:projectId/dwr/reconciliation/repair')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Set a drifted counter back to the approved measurement',
    description:
      'Explicit, permissioned, and recorded with the previous value. **Never automatic** — a ' +
      'discrepancy is the only symptom of whatever moved the counter without a report, and a ' +
      'silent self-heal would destroy that evidence every time it ran, so the underlying fault ' +
      'would never be found.\n\n' +
      'Refused when there is nothing to repair, rather than succeeding quietly: a caller chasing ' +
      'a drift needs to learn it is already gone, and a 200 would tell them their repair worked.',
  })
  @ApiResponse({ status: 409, description: 'Those lines already agree.' })
  async repair(
    @UserEntity() caller: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Body() dto: RepairDoneQtyDto,
    @Ip() ip: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.figures.repair(
      rlsContextFor(caller),
      projectId,
      resolveCompanyId(caller, companyId),
      dto,
      { userId: caller.id, ipAddress: ip },
    );
  }
}
