import { Controller, Get, Ip, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { UserEntity } from '../common/decorators/user.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { EmployeesService } from '../hr/employees/employees.service';
import { buildDashboardContext } from './context';
import { EmployeeSearchQueryDto } from './dto/employee-search-query.dto';
import { GroupCompanyCardProvider } from './widgets/group-company-card.provider';
import { StatutoryCalendarProvider } from './widgets/statutory-calendar.provider';
import type { WidgetResult } from './widgets/widget.types';
import { GroupAccessGuard } from './group-access.guard';

/**
 * The Group Dashboard (feature 004, US6): per-company cards + Group Total, a
 * cross-company employee search, and the statutory calendar. Scope is the caller's
 * accessible companies (spec FR-014–FR-017, FR-022).
 *
 * **Two of the three handlers override the class's `DASHBOARD` with `EMPLOYEES`
 * (2026-10-10).** Both read employee data: the cards carry each company's headcount,
 * and the search returns named, coded employees across every company the caller can
 * reach. `DASHBOARD` is held by every employee, so until this changed, anyone could
 * type three letters and get a cross-company staff directory.
 *
 * It is an override, not an addition — `@RequirePermissions(...)` is any-of, so listing
 * both would have widened the gate rather than narrowed it, and there is no all-of form.
 * The practical effect is the one intended: nobody reaches these without `EMPLOYEES`.
 * A caller holding `EMPLOYEES` but not `DASHBOARD` could now reach them by URL, which is
 * the direction that matters least — they can already read the roster itself, and the
 * web shell still gates the page on both.
 *
 * `statutory-calendar` keeps `DASHBOARD` at the route (2026-10-15). Since it became real
 * it does read payroll figures, but gates them itself, per scheme, on the permissions
 * the Challans and payroll screens use — a route-level `PAYROLL` would have hidden PF and
 * ESIC dates from a `CHALLANS`-only accountant who can open the challans themselves.
 * A caller holding neither gets an empty calendar.
 */
@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, GroupAccessGuard)
@RequirePermissions(Permission.DASHBOARD)
@Controller('group')
export class GroupController {
  constructor(
    private readonly groupCards: GroupCompanyCardProvider,
    private readonly calendar: StatutoryCalendarProvider,
    private readonly employees: EmployeesService,
  ) {}

  @Get('companies')
  @RequirePermissions(Permission.EMPLOYEES)
  @ApiOperation({
    summary: 'One card per accessible company, plus Group Total',
    description:
      'Each card carries that company’s headcount, so this needs `EMPLOYEES` rather ' +
      'than the `DASHBOARD` the rest of the module runs on. Beyond headcount a card ' +
      'carries ongoing projects and their contract value, the latest processed ' +
      'payroll run’s gross and PF + ESIC challan totals (with its month), active ' +
      'loans outstanding and required company documents missing — each present only ' +
      'when the caller holds the permission of the screen it comes from.',
  })
  async companies(@UserEntity() user: AuthenticatedUser, @Ip() ip: string) {
    return this.groupCards.buildCards(buildDashboardContext(user, ip));
  }

  @Get('statutory-calendar')
  @ApiOperation({
    summary:
      'Statutory due dates for the next 45 days, across accessible companies',
    description:
      'Computed, not recorded. PF and ESIC fall due on the 15th of the month after the ' +
      'payroll month, TDS on salary on the 7th (30 April for March). Each item names the ' +
      'company, scheme, payroll month, due date, days remaining and — once that month ' +
      'has a processed run — the amount the run puts on the challan (via ' +
      '`ChallansService`, the same figures the Challans screen shows). Dates passed in ' +
      'the last 7 days stay listed with a negative `daysRemaining`.\n\n' +
      'Still **not** a filing tracker: there is deliberately no `Challan` table (005 ' +
      'research §5), so nothing says whether a payment was made and nothing here ' +
      'claims it. Professional Tax is omitted — its due date is set per state and the ' +
      'product holds no per-state rule.\n\n' +
      'Schemes are gated per item: PF/ESIC need `CHALLANS` or `PAYROLL`, TDS needs ' +
      '`PAYROLL`.',
  })
  statutoryCalendar(
    @UserEntity() user: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<WidgetResult> {
    return this.calendar.build(buildDashboardContext(user, ip));
  }

  @Get('employees/search')
  @RequirePermissions(Permission.EMPLOYEES)
  @ApiOperation({
    summary: 'Cross-company employee search by name or code',
    description:
      'Scoped to the caller’s accessible companies. Min 2 characters. Needs ' +
      '`EMPLOYEES`: this is a staff directory, and a wider gate made it readable by ' +
      'everybody.',
  })
  async search(
    @UserEntity() user: AuthenticatedUser,
    @Ip() ip: string,
    @Query() query: EmployeeSearchQueryDto,
  ) {
    const ctx = buildDashboardContext(user, ip);
    return this.employees.searchByTerm(ctx.rls, query.q);
  }
}
