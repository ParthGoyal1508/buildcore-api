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
import type { WidgetResult } from './widgets/widget.types';

/**
 * The Group Dashboard (feature 004, US6): per-company cards + Group Total, a
 * cross-company employee search, and the not-yet-built statutory calendar. Scope is
 * the caller's accessible companies (spec FR-014–FR-017, FR-022).
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
 * `statutory-calendar` keeps `DASHBOARD`: it returns a fixed "module pending" envelope
 * and reads nothing.
 */
@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.DASHBOARD)
@Controller('group')
export class GroupController {
  constructor(
    private readonly groupCards: GroupCompanyCardProvider,
    private readonly employees: EmployeesService,
  ) {}

  @Get('companies')
  @RequirePermissions(Permission.EMPLOYEES)
  @ApiOperation({
    summary: 'One card per accessible company, plus Group Total',
    description:
      'Each card carries that company’s headcount, so this needs `EMPLOYEES` rather ' +
      'than the `DASHBOARD` the rest of the module runs on.',
  })
  async companies(@UserEntity() user: AuthenticatedUser, @Ip() ip: string) {
    return this.groupCards.buildCards(buildDashboardContext(user, ip));
  }

  @Get('statutory-calendar')
  @ApiOperation({
    summary: 'Statutory calendar — unavailable (Challans not built)',
  })
  statutoryCalendar(): WidgetResult {
    return {
      id: 'statutory-calendar',
      displayType: 'list',
      title: 'Statutory Calendar',
      section: 'group',
      unavailable: { reason: 'module_pending', module: 'challans' },
    };
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
