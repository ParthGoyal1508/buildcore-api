import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { rlsContextFor } from '../../common/prisma/rls-context';
import { SelfService } from '../../common/decorators/route-access.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { callerFrom } from '../caller-context';
import { EmployeesService } from '../employees/employees.service';
import { HolidaysService } from './holidays.service';

/**
 * The holiday list as an employee reads it (2026-10-15). The client: "as a user I don't have any
 * option to see the holiday list" — the calendar lives under HR → Attendance, gated on
 * `ATTENDANCE`, which an ordinary employee does not hold.
 *
 * Self-service: an employee sees their own company's holidays, the ones that apply to every site
 * and the ones declared for their own site. An account with no employee record — an administrator
 * — sees the selected company's whole calendar rather than an error, because a holiday list is
 * not personal data and refusing it would be the My Workspace failure the client reported.
 */
@ApiTags('My Workspace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@SelfService()
@Controller('my/holidays')
export class MyHolidaysController {
  constructor(
    private readonly holidays: HolidaysService,
    private readonly employees: EmployeesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The holidays of a year, for the caller' })
  async list(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query('year') year?: string,
  ) {
    const y =
      year && /^\d{4}$/.test(year) ? Number(year) : new Date().getFullYear();
    const ctx = rlsContextFor(user);
    const employee = await this.employees.getByUserId(ctx, user.id);
    const companyId = employee?.companyId ?? ctx.companyId ?? user.companyId;
    if (!companyId) {
      throw new BadRequestException('Choose a company to see its holidays.');
    }
    const rows = await this.holidays.list(
      callerFrom(user, request),
      companyId,
      {
        from: `${y}-01-01`,
        to: `${y}-12-31`,
        ...(employee ? { siteId: employee.siteId } : {}),
      },
    );
    return { year: y, holidays: rows };
  }
}

/**
 * Whether this login is an employee (2026-10-15) — what My Workspace asks before it shows the
 * punch clock, leave, salary and claims, all of which belong to an employee record. An account
 * created for an administrator has none, and those screens each failed with "Could not load this
 * list"; with this the workspace says once why, and still offers the holiday list.
 */
@ApiTags('My Workspace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@SelfService()
@Controller('my/employee')
export class MyEmployeeController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @ApiOperation({
    summary: 'The employee record this login belongs to, if any',
  })
  async whoAmI(@UserEntity() user: AuthenticatedUser) {
    const employee = await this.employees.getByUserId(
      rlsContextFor(user),
      user.id,
    );
    if (!employee) return { linked: false as const };
    return {
      linked: true as const,
      employeeCode: employee.employeeCode,
      name:
        [employee.firstName, employee.lastName].filter(Boolean).join(' ') ||
        employee.employeeCode,
    };
  }
}
