import {
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { rlsContextFor } from '../../common/prisma/rls-context';
import { resolveCompanyId } from '../../settings/company-scope';
import { RaBillsService } from './ra-bills.service';
import {
  ComposeRaBillDto,
  ReleaseRetentionDto,
  ReviseRaBillDto,
  SetAwardDto,
} from './dto/ra-bill.dto';

/**
 * Subcontractor bills measured against the award (018 US2) — `bugs.md` item 12.
 *
 * `PROJECT_FINANCIALS`, like the client bills beside it: this is money leaving on a contract.
 */
@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PROJECT_FINANCIALS)
@Controller('projects/ra-bills')
export class RaBillsController {
  constructor(private readonly bills: RaBillsService) {}

  @Get()
  @ApiOperation({
    summary: 'Every RA bill on a project, newest first',
    description:
      'Each bill carries its measured lines with the quantities FR-007 asks for — this period, to ' +
      'date and remaining — as at its own billing date.',
  })
  async list(
    @UserEntity() caller: AuthenticatedUser,
    @Query('projectId') projectId: string,
  ) {
    return this.bills.listForProject(rlsContextFor(caller), projectId);
  }

  /**
   * **Declared before `@Get(':id')`.** Nest matches in registration order, so with the
   * parameterised route first this path would be answered as "RA bill awards not found" — which
   * reads as a missing bill rather than as a route that never matched.
   */
  @Get('awards/:workOrderId')
  @ApiOperation({
    summary: 'The award with what has been measured against it (FR-007)',
    description:
      'Awarded, measured to date and remaining — **before** anybody types. A sheet showing only the ' +
      'award would make the biller work out the remainder from a column they cannot see.\n\n' +
      'Pass `excludeBillId` when loading the sheet to revise an existing bill: without it the bill ' +
      'counts its own quantities as measured, and every revision looks like an over-measurement of ' +
      'itself.',
  })
  async award(
    @UserEntity() caller: AuthenticatedUser,
    @Param('workOrderId') workOrderId: string,
    @Query('excludeBillId') excludeBillId?: string,
  ) {
    return this.bills.awardFor(rlsContextFor(caller), workOrderId, {
      excludeBillId,
    });
  }

  /**
   * **Also before `@Get(':id')`**, for the reason above: `retention` is a literal segment that the
   * parameterised route would otherwise swallow.
   */
  @Get('retention/:workOrderId')
  @ApiOperation({
    summary:
      'What a work order still holds back, and every release against it (FR-016a)',
    description:
      'Withheld, released and outstanding — all three, not just the balance. A subcontractor asking ' +
      '"how much are you still holding" is really asking "and how did it get to that", and a single ' +
      'figure sends somebody to add up bills by hand to answer the second half.\n\n' +
      '**Withheld counts only bills that have left draft.** A draft is a working document and its ' +
      'retention has been withheld from nobody.',
  })
  async retention(
    @UserEntity() caller: AuthenticatedUser,
    @Param('workOrderId') workOrderId: string,
  ) {
    return this.bills.retentionFor(rlsContextFor(caller), workOrderId);
  }

  @Post('retention/:workOrderId/release')
  @ApiOperation({
    summary: 'Record retention going back to the subcontractor (FR-016a)',
    description:
      '**An act somebody performs, never a schedule the system runs** — the client’s own answer of ' +
      '2026-10-03, chosen over two automatic schedules they were offered. Contract terms vary, and a ' +
      'schedule guessed wrong does not fail loudly: it quietly withholds money that was due or ' +
      'releases money that was not, and nobody notices until the subcontractor does.\n\n' +
      'Refuses `RETENTION_EXCEEDS_HELD` for more than the outstanding balance, and ' +
      '`RETENTION_RELEASE_REASON_REQUIRED` for a release with nothing said about it. Append-only: ' +
      'there is no edit, because the row *is* the evidence that money moved.',
  })
  async releaseRetention(
    @UserEntity() caller: AuthenticatedUser,
    @Param('workOrderId') workOrderId: string,
    @Body() dto: ReleaseRetentionDto,
  ) {
    return this.bills.releaseRetention(
      rlsContextFor(caller),
      workOrderId,
      dto,
      caller.id,
    );
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Discard a draft bill that should not exist',
    description:
      'Reported as "I raised the bill twice for the same date". A draft could be submitted, ' +
      'revised or left in the list for ever, and a duplicate left in the list is one somebody ' +
      'eventually submits.\n\n' +
      'A delete rather than a status, unlike `BillPackage.abandon`: a package occupies its period ' +
      'and the abandoned row records that the period was considered, while a bill raised by ' +
      'mistake records nothing anybody wants. Its lines and its **draft** package go with it, so ' +
      'the period is freed and the dates can be composed again.',
  })
  @ApiResponse({
    status: 409,
    description:
      '`BILL_NOT_DRAFT` — out of draft, carrying a payment, or belonging to a package that has ' +
      'already been issued.',
  })
  async discard(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ip: string,
    @Query('companyId') companyId?: string,
  ) {
    await this.bills.discard(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      id,
      { userId: caller.id, ipAddress: ip },
    );
    return { id, discarded: true };
  }

  @Post(':id/submit')
  @ApiOperation({
    summary: 'Send a measured bill for certification (FR-009’s precondition)',
    description:
      'The bill enters the `ra_bill` approval chain and becomes `submitted`. **Nothing is certified ' +
      'here** — the 016 spine decides, and the bill becomes `approved` when the chain completes.\n\n' +
      'The spine is asked **before** the bill’s status is written. A bill flipped to submitted with ' +
      'no instance behind it waits on nobody, sits in no queue, and looks to its author exactly like ' +
      'one that was submitted.',
  })
  @ApiResponse({
    status: 409,
    description:
      '`BILL_NOT_DRAFT`, or `APPROVAL_CHAIN_NOT_CONFIGURED` when no chain is defined for this ' +
      'company — a configuration gap, not a permissions problem.',
  })
  async submitForCertification(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    // No `companyId` parameter: the company comes from the bill, which the caller's RLS context
    // already scoped. Taking it from the query would be a second answer to a question already
    // settled, and the only way the two could differ is the wrong one winning.
    return this.bills.submitForCertification(rlsContextFor(caller), caller, id);
  }

  @Patch(':id/lines')
  @ApiOperation({
    summary:
      'Revise the measured quantities, invalidating any approval (FR-009)',
    description:
      'A **completed approval is never touched.** 016’s chain records what was approved, and editing ' +
      'quantities under a completed decision would leave the approver’s name against numbers they ' +
      'never saw. So the old instance stays as history and a new one is raised; a still-pending ' +
      'instance is abandoned, so nobody is left deciding a version that has been replaced.\n\n' +
      'The spine is asked **before** anything is written. If the chain cannot be reached, this ' +
      'refuses and the bill keeps both its quantities and its certification — because the other ' +
      'order produces a bill that reads as certified against numbers nobody signed.\n\n' +
      'Send the whole line set, not a patch: a bill’s totals and its over-measurement check are ' +
      'properties of all its lines together.',
  })
  @ApiResponse({
    status: 400,
    description:
      '`RA_BILL_REVISION_REASON_REQUIRED`, `BILL_HAS_NO_LINES`, or `RA_BILL_EXCEEDS_AWARD`.',
  })
  @ApiResponse({
    status: 409,
    description: '`RA_BILL_HAS_NO_AWARD` for a bill raised before 018.',
  })
  async revise(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReviseRaBillDto,
  ) {
    return this.bills.revise(rlsContextFor(caller), caller, id, dto);
  }

  @Put('awards/:workOrderId')
  @ApiOperation({
    summary: 'Capture the award — the subcontractor’s own rates (FR-006)',
    description:
      'Replaces the award rather than merging into it, and **refuses once anything has been measured ' +
      'against it**: changing an award under a measured bill would move the remaining quantity on a ' +
      'document already issued, and the subcontractor’s copy would then disagree with ours.\n\n' +
      'The link to a client BOQ line is optional. A subcontract can cover work the client’s BOQ ' +
      'itemises differently, and requiring a match would make somebody invent one.',
  })
  @ApiResponse({
    status: 409,
    description:
      'The award has been measured against. Raise a variation instead.',
  })
  async setAward(
    @UserEntity() caller: AuthenticatedUser,
    @Param('workOrderId') workOrderId: string,
    @Body() dto: SetAwardDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.bills.setAward(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      workOrderId,
      dto.lines,
    );
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'One measured bill, with this-period / to-date / remaining per line (FR-007)',
    description:
      'To-date is **as at this bill’s own date**, so a historical bill reads as it did when it was ' +
      'raised rather than showing today’s running total beside figures from then.',
  })
  async view(@UserEntity() caller: AuthenticatedUser, @Param('id') id: string) {
    return this.bills.view(rlsContextFor(caller), id);
  }

  @Post()
  @ApiOperation({
    summary: 'Measure a bill against the award (FR-007, FR-008)',
    description:
      'Returns **gross, each of the three deductions, and net separately**. Not one net figure: a ' +
      'subcontractor disputing a payment asks which deduction accounts for the difference.\n\n' +
      '`pnlAmount` is gross, and is on the response for a reason — retention is money withheld and an ' +
      'advance recovery is money already paid, so **neither is a project cost**, and a summary ' +
      'treating net as spend would understate the project.\n\n' +
      'Measuring more than the award is **refused**, unlike over-measuring a client BOQ. The asymmetry ' +
      'is about who is owed what: over-measuring a client BOQ is a claim they can reject, while ' +
      'over-measuring an award is the company agreeing to pay for work it never ordered, with nobody ' +
      'downstream to catch it.',
  })
  @ApiResponse({
    status: 400,
    description: '`RA_BILL_EXCEEDS_AWARD`, naming the lines and the remedy.',
  })
  async compose(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: ComposeRaBillDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.bills.compose(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      dto,
    );
  }
}
