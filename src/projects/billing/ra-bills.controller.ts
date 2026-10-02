import {
  Body,
  Controller,
  Get,
  Param,
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
import { ComposeRaBillDto, SetAwardDto } from './dto/ra-bill.dto';

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
