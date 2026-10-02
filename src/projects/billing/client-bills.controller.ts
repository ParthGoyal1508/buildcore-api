import {
  Body,
  Controller,
  Get,
  Param,
  Post,
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
import { ClientBillsService } from './client-bills.service';
import { CertifyBillDto, ComposeBillDto } from './dto/client-bill.dto';

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
  ) {
    return this.bills.listForProject(rlsContextFor(caller), projectId);
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
      'is 83 headings across 312 rows, and a flat list cannot represent it.\n\n' +
      '**Two totals, not one.** `estimatedTotal` is the schedule at its own rates; `quotedTotal` is ' +
      'that figure with the bidder’s percentage applied **once, to the total**. Applying it per line ' +
      'gives a figure close enough to pass a glance and wrong by rounding — the worst available ' +
      'outcome for a tender document.\n\n' +
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
  @ApiOperation({
    summary: 'Record what the client certified (FR-005)',
    description:
      '**Both figures are kept.** The billed amount is not overwritten and cumulative billed quantity ' +
      'is untouched: a shortfall is a dispute to pursue, not a correction to absorb, and a system ' +
      'that silently reduced what was billed would lose the only record that there was one.',
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
    return this.bills.certify(rlsContextFor(caller), id, dto.certifiedAmount);
  }
}
