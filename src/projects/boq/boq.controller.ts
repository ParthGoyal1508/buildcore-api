import {
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  Post,
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
import { ProjectLockGuard } from '../guards/project-lock.guard';
import { BoqImportService } from './boq-import.service';
import { BoqService } from './boq.service';
import {
  ConfirmBoqImportDto,
  CreateBoqGroupDto,
  CreateBoqItemDto,
  ValidateBoqImportDto,
} from './dto/boq.dto';

/**
 * The BOQ: entry, the tree, the alerts, and the two-step tender import (008 US4).
 *
 * `PROJECTS` rather than `PROJECT_FINANCIALS`, unlike the billing controllers next door. A BOQ is
 * the schedule of what is to be built; it carries rates, but entering one is project work and a
 * site engineer who may not see a bill may certainly need to see the schedule.
 *
 * `ProjectLockGuard` on every write, including both import steps — importing a schedule into a
 * frozen project is exactly the kind of write the lock exists to stop.
 */
@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PROJECTS)
@Controller('projects/:id/boq')
export class BoqController {
  constructor(
    private readonly boq: BoqService,
    private readonly imports: BoqImportService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The project’s BOQ as a two-level tree',
    description:
      'Programme columns are **null where the line is unplanned** (FR-037) — never 0 and never a ' +
      'sentinel date. An imported tender is entirely unplanned on the day it arrives, so a reader ' +
      'has to be able to tell "nobody has planned this" from "planned for today".',
  })
  async tree(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') projectId: string,
  ) {
    return this.boq.getTree(rlsContextFor(caller), projectId);
  }

  @Get('alerts')
  @ApiOperation({
    summary:
      'What needs attention: today, delayed, to be delayed, and unplanned',
    description:
      'Four groups, mutually exclusive (FR-048). **Unplanned is the fourth** — an imported tender ' +
      'is neither late nor on schedule, and three groups would mean its lines are silently absent ' +
      'from the one screen whose claim is to show what needs attention. A line needing nobody’s ' +
      'attention appears in none of the four.',
  })
  async alerts(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') projectId: string,
  ) {
    return this.boq.getAlerts(rlsContextFor(caller), projectId);
  }

  @Post('groups')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({ summary: 'Add a BOQ section' })
  async createGroup(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') projectId: string,
    @Body() body: CreateBoqGroupDto,
  ) {
    return this.boq.createGroup(
      rlsContextFor(caller),
      projectId,
      body,
      resolveCompanyId(caller),
    );
  }

  @Post('items')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Add a measurable line',
    description:
      'The four programme fields are optional. A line with no dates is unplanned, which is the ' +
      'normal state of a schedule nobody has programmed yet.',
  })
  async createItem(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') projectId: string,
    @Body() body: CreateBoqItemDto,
  ) {
    return this.boq.createItem(
      rlsContextFor(caller),
      projectId,
      body,
      resolveCompanyId(caller),
    );
  }

  @Delete('items/:itemId')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({ summary: 'Remove a line that nothing measures against' })
  @ApiResponse({
    status: 409,
    description:
      'A daily work report, a client bill line or a work-order award line already references it. ' +
      'Three relations, not one: checking only the first would let a billed line be deleted out ' +
      'from under a submitted bill.',
  })
  async deleteItem(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') projectId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.boq.deleteItem(rlsContextFor(caller), projectId, itemId);
  }

  @Post('import/validate')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Read a tender workbook and report what it says — writing nothing',
    description:
      'The workbook base64-encoded in JSON, matching every other upload in this product. ' +
      'Accepts `.xlsx` and legacy `.xls`, routed on content rather than filename. Returns both ' +
      'derived totals beside the two the workbook itself states, the quoted percentage or a plain ' +
      'statement that it was not found, every rejected row with its reason, and warnings apart ' +
      'from errors. **A response carrying zero lines is not possible** — every empty condition is ' +
      'a refusal naming itself (FR-036), because a successful import of nothing is ' +
      'indistinguishable from a working import of an empty project.',
  })
  @ApiResponse({
    status: 400,
    description: 'One of the fourteen named refusals.',
  })
  async validateImport(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') projectId: string,
    @Body() body: ValidateBoqImportDto,
  ) {
    return this.imports.validate({
      buffer: Buffer.from(body.file, 'base64'),
      companyId: resolveCompanyId(caller),
      userId: caller.id,
      projectId,
      ctx: rlsContextFor(caller),
    });
  }

  @Post('import/confirm')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Commit a reviewed batch — once, by the person who reviewed it',
    description:
      'One transaction. Refused if the project already has lines, if the batch belongs to someone ' +
      'else or another project, or if it has already been imported — and the refusal says which, ' +
      'because "it already worked" and "it never existed" need opposite actions.',
  })
  async confirmImport(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') projectId: string,
    @Body() body: ConfirmBoqImportDto,
    @Ip() ipAddress: string,
  ) {
    return this.imports.confirm({
      batchId: body.batchId,
      companyId: resolveCompanyId(caller),
      userId: caller.id,
      projectId,
      ctx: rlsContextFor(caller),
      ipAddress,
    });
  }
}
