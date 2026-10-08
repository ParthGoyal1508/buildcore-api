import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Patch,
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
import {
  CreateWorkOrderDto,
  ReopenAwardDto,
  UpdateWorkOrderDto,
} from './dto/work-order.dto';
import { WorkOrdersService } from './work-orders.service';

/**
 * Work orders, in the minimal form 018 needs (018 US2).
 *
 * **This is feature 008 User Story 6's surface, delivered small.** The table has existed since 008
 * and nothing has ever written to it, which left 018's whole RA bill story — the award, the
 * measured bill, the approval invalidation — reachable by nobody. See `WorkOrdersService` for what
 * this deliberately is not.
 *
 * `PROJECT_FINANCIALS`, like the bills beside it: a work order commits the company to pay somebody.
 */
@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PROJECT_FINANCIALS)
@Controller('projects/work-orders')
export class WorkOrdersController {
  constructor(private readonly workOrders: WorkOrdersService) {}

  @Get()
  @ApiOperation({
    summary: 'Every work order on a project, newest first',
    description:
      '`awardLineCount` is 0 until the award is captured, and nothing can be measured against a ' +
      'work order with no award — so the sheet can say that rather than presenting an empty grid.',
  })
  async list(
    @UserEntity() caller: AuthenticatedUser,
    @Query('projectId') projectId: string,
  ) {
    return this.workOrders.listForProject(rlsContextFor(caller), projectId);
  }

  @Post()
  @ApiOperation({ summary: 'Raise a work order' })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateWorkOrderDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.workOrders.create(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      dto,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'One work order' })
  async view(@UserEntity() caller: AuthenticatedUser, @Param('id') id: string) {
    return this.workOrders.view(rlsContextFor(caller), id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit a work order’s details, retention or status',
    description:
      'Refuses a `retentionPercent` change once a bill has been raised — the retention on an issued ' +
      'bill is already withheld at the old rate, and moving the basis would make the ' +
      'subcontractor’s copy disagree with ours about money already held.',
  })
  @ApiResponse({ status: 400, description: '`WORK_ORDER_RETENTION_LOCKED`.' })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateWorkOrderDto,
  ) {
    return this.workOrders.update(rlsContextFor(caller), id, dto);
  }

  @Post(':id/submit')
  @ApiOperation({
    summary: 'Send the award for approval',
    description:
      'A work order commits the company, so it is approved before it becomes active (028 FR-009). ' +
      'Until this existed an award went active the moment one person saved it, while the first ' +
      'bill raised under it required an approval — the control was the wrong way round. The award ' +
      'becomes active when the chain completes, never on a save.',
  })
  @ApiResponse({
    status: 400,
    description:
      '`WORK_ORDER_NO_AWARD_LINES` — nothing is awarded yet, so there is nothing to approve.',
  })
  @ApiResponse({
    status: 409,
    description: '`WORK_ORDER_WRONG_STATUS` — only a draft award can be sent.',
  })
  async submit(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.workOrders.submitForApproval(rlsContextFor(caller), caller, id);
  }

  @Post(':id/reopen')
  @ApiOperation({
    summary: 'Reopen an approved award so it can be corrected',
    description:
      'Takes the work order back to `draft` and **voids the approval**, which then has to be ' +
      'given again.\n\n' +
      'It exists because capturing the award is now refused on anything but a draft. Before that, ' +
      'an approved award could be rewritten in place for as long as no bill had been measured ' +
      'against it — so the approval stood against figures that no longer existed. Closing that ' +
      'left an approved award with a wrong rate nowhere to go, because the "raise a variation" ' +
      'the billed path names is advice rather than a feature.\n\n' +
      'Deliberately its own action rather than a side effect of saving: an edit that quietly ' +
      'cancelled an approval would remove one without the person noticing they had.',
  })
  @ApiResponse({
    status: 409,
    description:
      '`WORK_ORDER_WRONG_STATUS` — already a draft. ' +
      '`WORK_ORDER_AWARD_BILLED` — measured against, and reopening would move the remaining ' +
      'quantity under bills the subcontractor already holds.',
  })
  async reopen(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReopenAwardDto,
    @Ip() ip: string,
  ) {
    return this.workOrders.reopenAward(
      rlsContextFor(caller),
      caller,
      id,
      dto.reason,
      ip,
    );
  }
}
