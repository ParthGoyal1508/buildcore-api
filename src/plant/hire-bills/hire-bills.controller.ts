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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import {
  CreateHireBillDto,
  ListHireBillsDto,
  PayHireBillDto,
} from './dto/hire-bill.dto';
import { HireBillsService } from './hire-bills.service';

/**
 * Hire bills (006 US7), gated by `HIRE_BILLS` — the other value this feature adds.
 *
 * Separate from `MAINTENANCE` on purpose: approving a rental invoice is an accounts
 * decision, and the person who signs it off is usually not the person who fixes the
 * machine.
 */
@ApiTags('Plant')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.HIRE_BILLS)
@Controller('plant/hire-bills')
export class HireBillsController {
  constructor(private readonly hireBills: HireBillsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Paginated hire bills, with pending-verification and unpaid totals',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListHireBillsDto,
  ) {
    return this.hireBills.findAll(caller, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Raise a hire bill',
    description:
      "Rate defaults to the effective hire rate for the machine's category on the " +
      "period's start date. Logbook hours are snapshotted and every financial " +
      'field is computed server-side. Refused for owned equipment (FR-022).',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateHireBillDto,
    @Ip() ipAddress: string,
  ) {
    return this.hireBills.create(caller, dto, ipAddress);
  }

  @Patch(':id/verify')
  @ApiOperation({
    summary: 'Verify a bill',
    description:
      'The variance against logbook hours is recorded, not enforced — verification ' +
      'is an admin decision, not an automated gate.',
  })
  async verify(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    return this.hireBills.verify(caller, id, ipAddress);
  }

  @Patch(':id/pay')
  @ApiOperation({
    summary: 'Record payment',
    description: '409 against an unverified bill.',
  })
  async pay(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PayHireBillDto,
    @Ip() ipAddress: string,
  ) {
    return this.hireBills.pay(caller, id, dto, ipAddress);
  }
}
