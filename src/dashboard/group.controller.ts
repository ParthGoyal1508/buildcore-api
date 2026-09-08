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
  @ApiOperation({
    summary: 'One card per accessible company, plus Group Total',
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
  @ApiOperation({
    summary: 'Cross-company employee search by name or code',
    description:
      'Scoped to the caller’s accessible companies. Min 2 characters.',
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
