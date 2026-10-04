import { Controller, Ip, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AccessLevel, Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequireLevel } from '../../common/decorators/access-level.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { FuelRecoveryService } from './fuel-recovery.service';

/**
 * Recovering a confirmed fuel loss (020 FR-003 to FR-007, FR-010).
 *
 * Separate from the review controller on purpose: reviewing decides who bears a loss and recovering
 * takes the money. Keeping them apart is what lets a reviewer work a list of exceptions without each
 * click costing somebody money, and it means the two can carry different permissions if they ever
 * need to.
 */
@ApiTags('Plant — Fuel recovery')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.MACHINERY)
@RequireLevel(AccessLevel.write)
@Controller('plant/fuel-exceptions/:id')
export class FuelRecoveryController {
  constructor(private readonly recovery: FuelRecoveryService) {}

  @Post('recover/hire-bill')
  @ApiOperation({
    summary: 'Deduct a confirmed loss from the hire bill (FR-003, FR-004)',
    description:
      'Finds the bill covering the date the fuel was issued and recomputes its net payable from ' +
      'its components — never by decrementing, so the vendor can be shown the arithmetic.\n\n' +
      'A **paid** bill is never adjusted: the recovery carries to the next unpaid bill for the same ' +
      'equipment and vendor. Adjusting a paid bill would change a figure already transferred ' +
      'against.\n\n' +
      'No approval chain. A hire bill is a document the company is still assembling, and an ' +
      'adjustment before payment is not money leaving.',
  })
  @ApiResponse({
    status: 400,
    description:
      'FUEL_RECOVERY_NOT_CONFIRMED, FUEL_RECOVERY_WRONG_ATTRIBUTION, ' +
      'FUEL_RECOVERY_ALREADY_RECOVERED, FUEL_RECOVERY_NOTHING_TO_RECOVER, ' +
      'FUEL_RECOVERY_NO_HIRE_BILL or FUEL_RECOVERY_NO_UNPAID_BILL.',
  })
  async toHireBill(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    return this.recovery.deductFromHireBill(caller, id, ipAddress);
  }

  @Post('recover/operator')
  @ApiOperation({
    summary:
      "Recover a confirmed loss from the operator's salary (FR-005, FR-006)",
    description:
      'Raises the recovery and submits it to the approval chain. It reaches **no payroll line until ' +
      'it is approved** — the payroll engine reads only approved recoveries, so that is a property ' +
      'of the query rather than a check that could be omitted.\n\n' +
      'Applied on the next payroll run rather than at the moment of approval: the period may have no ' +
      'run yet, or one already approved or paid, and rewriting that would change a figure somebody ' +
      'has transferred against.\n\n' +
      'Capped at half the payslip’s wages **counting every other deduction** (FR-007a), with the ' +
      'remainder carried to the following period.',
  })
  @ApiResponse({
    status: 400,
    description:
      'As above, plus FUEL_RECOVERY_OPERATOR_UNKNOWN when no operator is named on the exception.',
  })
  async toOperator(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    return this.recovery.raiseOperatorRecovery(caller, id, ipAddress);
  }

  @Post('recover/reverse')
  @ApiOperation({
    summary:
      'Reverse a recovery after the reading behind it is corrected (FR-010)',
    description:
      'A hire-bill deduction is **deleted** and the net recomputed. An operator recovery is **marked ' +
      'reversed and kept**. The asymmetry is deliberate: a deduction on an unpaid bill never left the ' +
      'company, while a recovery may already have reduced somebody’s pay — and a row deleted from ' +
      'under a payslip makes that payslip unexplainable.',
  })
  async reverse(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    return this.recovery.reverse(caller, id, ipAddress);
  }
}
