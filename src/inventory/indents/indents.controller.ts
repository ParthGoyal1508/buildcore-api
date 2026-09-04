import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import {
  ApproveIndentDto,
  CreateIndentDto,
  IndentDecisionDto,
  ListIndentsDto,
  MarkProcurementNeededDto,
} from './dto/indent.dto';
import { IndentsService } from './indents.service';

/**
 * Material indents.
 *
 * `INVENTORY` at the class level, with `INVENTORY_APPROVE` overriding it on the two
 * endpoints that decide an indent's fate (FR-029). `PermissionsGuard` is any-of and
 * a method-level decorator replaces the class-level one, so approve and reject
 * require the approval permission *instead of* `INVENTORY`, not in addition to it —
 * which is why the approver role needs both values.
 */
@ApiTags('Inventory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.INVENTORY)
@Controller('inventory/indents')
export class IndentsController {
  constructor(private readonly indents: IndentsService) {}

  @Get()
  @ApiOperation({
    summary: 'Paginated indent list',
    description:
      'Every line carries requested, approved, fulfilled and outstanding ' +
      'quantities. `overdue` is computed against `requiredByDate` on read.',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListIndentsDto,
  ) {
    return this.indents.findAll(caller, query);
  }

  @Get('procurement-needed')
  @ApiOperation({
    summary: 'What needs buying, from two separate sources',
    description:
      'Indent demand and reorder-level shortfall are returned as two labelled ' +
      'lists and never summed — the same item can legitimately appear in both, and ' +
      'adding them would order the material twice (FR-027).',
  })
  async procurementNeeded(
    @UserEntity() caller: AuthenticatedUser,
    @Query('companyId') companyId?: string,
  ) {
    return this.indents.procurementNeeded(caller, companyId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One indent with its lines' })
  async findOne(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.indents.findOne(caller, id);
  }

  @Post()
  @ApiOperation({
    summary: 'Raise an indent',
    description: 'A retired item is refused with 400.',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateIndentDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.indents.create(caller, dto, ipAddress, companyId);
  }

  @Post(':id/approve')
  @RequirePermissions(Permission.INVENTORY_APPROVE)
  @ApiOperation({
    summary: 'Approve an indent, line by line',
    description:
      'A line may be approved below the quantity requested, with a reason — both ' +
      'figures are kept so the reduction stays auditable. Approval does NOT reserve ' +
      'stock (FR-025): no balance changes here, and issue-time validation remains ' +
      'the only enforcement point.',
  })
  async approve(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ApproveIndentDto,
    @Ip() ipAddress: string,
  ) {
    return this.indents.approve(caller, id, dto, ipAddress);
  }

  @Post(':id/reject')
  @RequirePermissions(Permission.INVENTORY_APPROVE)
  @ApiOperation({
    summary: 'Reject an indent',
    description: 'A reason is required — 400 without one.',
  })
  async reject(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: IndentDecisionDto,
    @Ip() ipAddress: string,
  ) {
    return this.indents.reject(caller, id, dto, ipAddress);
  }

  @Post(':id/cancel')
  @ApiOperation({
    summary: 'Cancel an indent',
    description: '409 once any line has been fulfilled. A reason is required.',
  })
  async cancel(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: IndentDecisionDto,
    @Ip() ipAddress: string,
  ) {
    return this.indents.cancel(caller, id, dto, ipAddress);
  }

  @Post(':id/mark-procurement-needed')
  @ApiOperation({
    summary:
      'Flag approved lines that need buying rather than issuing from stock',
  })
  async markProcurementNeeded(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: MarkProcurementNeededDto,
    @Ip() ipAddress: string,
  ) {
    return this.indents.markProcurementNeeded(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Soft-delete an indent',
    description: '409 once any line has been fulfilled.',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    await this.indents.remove(caller, id, ipAddress);
  }
}
