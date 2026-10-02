import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { rlsContextFor } from '../../common/prisma/rls-context';
import { resolveCompanyId } from '../../settings/company-scope';
import { ProjectPnlService } from './project-pnl.service';

/**
 * The project P&L and the group view (018 US3) — `bugs.md` item 11's "P&L and Budget Summary".
 */
@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PROJECT_FINANCIALS)
@Controller('projects/pnl')
export class ProjectPnlController {
  constructor(private readonly pnl: ProjectPnlService) {}

  @Get()
  @ApiOperation({
    summary: 'One project’s position for one month, with cumulative beside it',
    description:
      'Revenue is **billed gross** on bills that have left draft, before retention — `revenueNote` on ' +
      'the response says so, because a reader comparing it to the bank will find a gap and a figure ' +
      'somebody cannot reconcile is a figure they stop trusting.\n\n' +
      'Cost is gross too: an RA bill’s retention is money withheld and its advance recovery is money ' +
      'already paid, so **neither is a cost**. Reading net would understate every project by the ' +
      'retention held across it.\n\n' +
      '**A category whose module registered no source is named in `unavailableCategories` and excluded ' +
      'from the totals** (FR-010). Counting it as zero is how a project looks profitable because half ' +
      'its costs are invisible.',
  })
  async summary(
    @UserEntity() caller: AuthenticatedUser,
    @Query('projectId') projectId: string,
    @Query('period') period: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.pnl.summaryFor(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      projectId,
      period,
    );
  }

  @Get('group')
  @ApiOperation({
    summary: 'Every named project’s position for one month, and the total',
    description:
      'The total **is** the sum of the rows, by construction: each cost source is asked once for all ' +
      'the projects and the rows are summed. Not a second aggregate query, which is how a total and ' +
      'its rows come to disagree (research §7).',
  })
  async group(
    @UserEntity() caller: AuthenticatedUser,
    @Query('projectIds') projectIds: string,
    @Query('period') period: string,
    @Query('companyId') companyId?: string,
  ) {
    const ids = projectIds
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    const rows = await this.pnl.summariesFor(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      ids,
      period,
    );
    const list = [...rows.values()];
    return {
      period,
      rows: list,
      // Summed from the rows returned, so the figure a reader checks by hand is the figure here.
      totals: {
        revenueCumulative: round(
          list.reduce((sum, row) => sum + row.revenueCumulative, 0),
        ),
        costCumulative: round(
          list.reduce((sum, row) => sum + row.costCumulative, 0),
        ),
        marginCumulative: round(
          list.reduce((sum, row) => sum + row.marginCumulative, 0),
        ),
      },
      // The union across rows. A category unavailable on one project is unavailable on all of them —
      // it is a deployment fact, not a project one — but saying so once at the top is clearer than
      // leaving a reader to notice the same note on sixty rows.
      unavailableCategories: [
        ...new Set(list.flatMap((row) => row.unavailableCategories)),
      ],
    };
  }
}

const round = (value: number): number => Math.round(value * 100) / 100;
