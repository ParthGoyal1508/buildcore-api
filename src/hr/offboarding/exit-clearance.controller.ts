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
import { WaiveClearanceDto } from './dto/waive-clearance.dto';
import { ExitClearanceService } from './exit-clearance.service';

/**
 * Exit clearance (021 FR-014 to FR-018b) — `bugs.md` item 10.
 *
 * `EMPLOYEES`: the people who manage an employee's record are the people who clear their exit.
 * Under 019's level model the GET needs read and the waiver needs write, derived from the verb —
 * which is exactly right here, since waiving writes off company money.
 *
 * **Waiver authority is an open client question.** Until they answer, it requires the same
 * permission as the rest of this surface, which is the narrowest defensible reading. Recorded as
 * an assumption rather than presented as the answer.
 */
@ApiTags('HR')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.EMPLOYEES)
@Controller('hr/employees/:employeeId/exit-clearance')
export class ExitClearanceController {
  constructor(private readonly clearance: ExitClearanceService) {}

  @Get()
  @ApiOperation({
    summary: 'What this leaver still owes, and what has been waived',
    description:
      'Derived on every read from the modules that own each obligation — asset custody, ' +
      'recoverable kit, outstanding advances. Nothing is stored but the waivers, so an asset ' +
      'returned through the asset register satisfies its item here with no second action ' +
      '(FR-014c), and an allocation opened after the exit was initiated is caught rather than ' +
      'missed (FR-014e).',
  })
  async get(
    @UserEntity() caller: AuthenticatedUser,
    @Param('employeeId') employeeId: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.clearance.forEmployee(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      employeeId,
    );
  }

  @Post('waivers')
  @ApiOperation({
    summary: 'Propose that the company stop pursuing one obligation',
    description:
      'HR proposes; the Director countersigns (FR-016, changed 2026-10-02). This **submits an ' +
      'approval item and writes no waiver** — the clearance comes back still blocked, and the ' +
      'obligation clears only when the item is approved. A rejected proposal leaves it ' +
      'outstanding.\n\n' +
      'A waiver records that the company is not chasing this, with a name and a reason ' +
      'against the decision. It does **not** mark the obligation discharged: an asset waived ' +
      'here stays open in the asset register, because marking it returned would put a false ' +
      'fact in the register that owns the truth (FR-014c).',
  })
  @ApiResponse({
    status: 403,
    description:
      'Proposing a waiver is an HR action — write access to employee records is not enough.',
  })
  @ApiResponse({
    status: 404,
    description: 'That obligation is not on this exit’s clearance.',
  })
  @ApiResponse({
    status: 409,
    description:
      'A waiver for this obligation is already pending, or already countersigned.',
  })
  async waive(
    @UserEntity() caller: AuthenticatedUser,
    @Param('employeeId') employeeId: string,
    @Body() dto: WaiveClearanceDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.clearance.waive(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      employeeId,
      dto,
      caller,
    );
  }
}
