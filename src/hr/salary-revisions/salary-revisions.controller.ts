import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { rlsContextFor } from '../../common/prisma/rls-context';
import { callerFrom } from '../caller-context';
import { CreateSalaryRevisionDto } from './dto/salary-revision.dto';
import { SalaryRevisionsService } from './salary-revisions.service';

/**
 * An employee's salary revision history — the increment letter's effective date and before/after pay.
 *
 * `PAYROLL`, not `EMPLOYEES`: this changes what the employee is paid, and it is the same permission
 * the increment letter is issued under (letter-permissions.ts). Read and write levels derive from
 * the verb, as everywhere under 019's level model.
 */
@ApiTags('HR — Salary revisions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PAYROLL)
@Controller('hr/employees/:employeeId/salary-revisions')
export class SalaryRevisionsController {
  constructor(private readonly revisions: SalaryRevisionsService) {}

  @Get()
  @ApiOperation({
    summary: "This employee's salary revisions, newest effective date first",
    description:
      'Each row carries `previousGross` and `gross` — the monthly gross (sum of the five heads) ' +
      'before and after the revision.',
  })
  async list(
    @UserEntity() caller: AuthenticatedUser,
    @Param('employeeId') employeeId: string,
  ) {
    return this.revisions.listFor(rlsContextFor(caller), employeeId);
  }

  @Post()
  @ApiOperation({
    summary: 'Revise the salary, from an effective date',
    description:
      '**Applies immediately**: the new heads are written onto the employee, which is what payroll ' +
      'pays from. Omitted heads keep their current value. Refused (400) with `code` ' +
      '`SALARY_REVISION_FUTURE_DATE` for a date after today, `SALARY_REVISION_BEFORE_LATEST` for ' +
      'a date before the latest revision, and `SALARY_REVISION_NO_CHANGE` when no head changes.',
  })
  async create(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('employeeId') employeeId: string,
    @Body() dto: CreateSalaryRevisionDto,
  ) {
    return this.revisions.create(callerFrom(user, request), employeeId, dto);
  }
}
