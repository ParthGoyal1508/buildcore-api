import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { rlsContextFor } from '../../common/prisma/rls-context';
import { resolveCompanyId } from '../../settings/company-scope';
import {
  ProjectPositionExportService,
  type PositionExportFormat,
} from './position-export.service';
import { PnlDrillDownService } from './pnl-drill-down.service';
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
  constructor(
    private readonly pnl: ProjectPnlService,
    private readonly exports: ProjectPositionExportService,
    private readonly drillDown: PnlDrillDownService,
  ) {}

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

  @Get('drill-down')
  @ApiOperation({
    summary:
      'Open any figure on the summary and see what it is made of (FR-012)',
    description:
      'The total returned is **summed from the records returned**, never queried separately. A ' +
      'drill-down whose rows do not add up to the total is worse than none: it tells the reader ' +
      'the number is wrong without telling them how, and from then on they check everything by ' +
      'hand.\n\n' +
      '`records: null` with an `unavailableReason` means this figure cannot be itemised — either ' +
      'no module registered a source for it, or the module reports a period total without listing ' +
      'what is behind it. **That is not an empty list**, because "we cannot itemise this" and ' +
      '"nothing was spent" are different facts and a reader acts differently on each.\n\n' +
      'Labour carries `itemisedFurtherAt`: the per-worker register is one request away rather than ' +
      'copied in here.',
  })
  async openFigure(
    @UserEntity() caller: AuthenticatedUser,
    @Query('projectId') projectId: string,
    @Query('period') period: string,
    @Query('figure') figure: string,
    @Query('scope') scope?: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.drillDown.drillInto(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      projectId,
      period,
      figure,
      scope === 'cumulative' ? 'cumulative' : 'month',
    );
  }

  @Get('export')
  @ApiOperation({
    summary:
      'The month’s position as a document that can be handed to a client (FR-011a)',
    description:
      'The same figures the screen is served, in the repository’s existing report formats — no ' +
      'second export mechanism.\n\n' +
      '**It carries the instant it was produced**, in the document and in the filename. The spec’s ' +
      'edge case is a payment sheet reopened and re-approved after a month was exported, and the ' +
      'production time is the only thing that lets two exports of the same month be told apart: ' +
      'without it the older document is indistinguishable from the current position and somebody ' +
      'quotes it to a client.\n\n' +
      'A figure that is hidden by the company’s cash setting, or that belongs to a module which ' +
      'registered no cost source, exports as **words** — `Hidden`, `Not available` — never as a ' +
      'zero. A zero is a figure, and a spreadsheet summing the column cannot tell one from the other.',
  })
  async exportPosition(
    @UserEntity() caller: AuthenticatedUser,
    @Query('projectId') projectId: string,
    @Query('period') period: string,
    @Res() res: Response,
    @Query('format') format?: string,
    @Query('companyId') companyId?: string,
  ) {
    const chosen = (format ?? 'pdf').toLowerCase();
    if (chosen !== 'pdf' && chosen !== 'excel') {
      throw new BadRequestException('format must be pdf or excel');
    }

    const document = await this.exports.export(
      caller,
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      projectId,
      period,
      chosen as PositionExportFormat,
    );

    res.setHeader('Content-Type', document.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${document.filename}"`,
    );
    res.status(200).send(document.buffer);
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
