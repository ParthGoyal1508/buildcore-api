import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
  CreateServiceBillDto,
  ListServiceBillsDto,
  PayServiceBillDto,
} from './dto/service-bill.dto';
import { ServiceBillsService } from './service-bills.service';

/**
 * Third-party service bills (006 US11), gated by `MAINTENANCE`.
 *
 * A service bill is a workshop's invoice for repairing a machine you own. A hire
 * bill is an owner's charge for letting you use theirs. FR-022 requires the two to
 * be distinct records, and they are gated differently for the same reason they are
 * separate: repairs are the workshop's world, rentals are accounts'.
 */
@ApiTags('Plant')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.MAINTENANCE)
@Controller('plant/service-bills')
export class ServiceBillsController {
  constructor(private readonly serviceBills: ServiceBillsService) {}

  @Get()
  @ApiOperation({
    summary: 'Paginated service bills with a pending-payment total',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListServiceBillsDto,
  ) {
    return this.serviceBills.findAll(caller, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Record a service bill',
    description:
      'TDS and net payable are computed server-side (FR-021). Permitted against a ' +
      'closed job — invoices routinely arrive after the work is done. 409 on a ' +
      'duplicate bill number for the same vendor.',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateServiceBillDto,
    @Ip() ipAddress: string,
  ) {
    return this.serviceBills.create(caller, dto, ipAddress);
  }

  @Patch(':id/verify')
  @ApiOperation({
    summary: 'Verify a bill',
    description:
      'Freezes its figures — there is no edit path afterwards (FR-023).',
  })
  async verify(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    return this.serviceBills.verify(caller, id, ipAddress);
  }

  @Patch(':id/pay')
  @ApiOperation({
    summary: 'Record a payment',
    description:
      '409 against an unverified bill. A payment short of the net payable marks it ' +
      'partially paid; payments accumulate.',
  })
  async pay(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PayServiceBillDto,
    @Ip() ipAddress: string,
  ) {
    return this.serviceBills.pay(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Withdraw an unverified bill',
    description:
      'Soft-delete only (FR-027). 409 once verified — its figures are already part ' +
      "of that machine's maintenance cost.",
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    await this.serviceBills.remove(caller, id, ipAddress);
  }
}
