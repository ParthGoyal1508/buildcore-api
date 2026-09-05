import {
  Body,
  Controller,
  Get,
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
import { AllocationService } from './allocation.service';
import {
  CreateAllocationDto,
  ListAllocationsDto,
  ReturnAllocationDto,
} from './dto/allocation.dto';

/** Allocation, return and the custody register (spec US3). */
@ApiTags('Assets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.ASSETS)
@Controller('assets/allocations')
export class AllocationController {
  constructor(private readonly allocations: AllocationService) {}

  @Get()
  @ApiOperation({ summary: 'Allocations, filtered and paginated' })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListAllocationsDto,
  ) {
    return this.allocations.findAll(caller, query);
  }

  @Get('custody')
  @ApiOperation({
    summary: 'Everything still out, grouped by custodian (FR-011)',
  })
  async getCustody(
    @UserEntity() caller: AuthenticatedUser,
    @Query('companyId') companyId?: string,
  ) {
    return this.allocations.getOutstandingCustody(caller, companyId);
  }

  @Post()
  @ApiOperation({
    summary: 'Allocate an asset to a project site',
    description:
      '409 when a serialised asset already has an open allocation; 400 when the ' +
      'category requires a custodian and none is named, or the custodian is ' +
      'posted at another site (FR-010).',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateAllocationDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.allocations.create(caller, dto, ipAddress, companyId);
  }

  @Post(':id/return')
  @ApiOperation({
    summary: 'Return an allocated asset',
    description:
      'The condition grade decides where the asset lands: a scrap grade condemns ' +
      'it, a damaged grade sends it for repair, anything else returns it to idle ' +
      '(FR-015).',
  })
  async returnAllocation(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReturnAllocationDto,
    @Ip() ipAddress: string,
  ) {
    return this.allocations.returnAllocation(caller, id, dto, ipAddress);
  }
}
