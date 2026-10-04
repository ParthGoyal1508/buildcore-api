import {
  Body,
  Controller,
  Get,
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
import { CreateWorkOrderDto, UpdateWorkOrderDto } from './dto/work-order.dto';
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
}
