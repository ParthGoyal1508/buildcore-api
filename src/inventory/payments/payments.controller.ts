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
import {
  AttachPaymentProofDto,
  CreatePaymentDto,
  ListBillsDto,
  ListPaymentsDto,
} from './dto/payment.dto';
import { PaymentsService } from './payments.service';

@ApiTags('Inventory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.INVENTORY)
@Controller('inventory')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('payments')
  @ApiOperation({
    summary: 'Paginated payment list',
    description:
      'Each row carries `allocatedBillCount` and `unallocatedBalance` — the part of ' +
      'the payment that found no bill to settle.',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListPaymentsDto,
  ) {
    return this.payments.findAll(caller, query);
  }

  @Get('bills')
  @ApiOperation({
    summary: "A vendor's outstanding bills and their total",
    description:
      'Informational only. Allocation is automatic and server-side, so nothing the ' +
      'client does with this list changes where a payment lands.',
  })
  async findBills(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListBillsDto,
  ) {
    return this.payments.findBills(caller, query);
  }

  @Post('payments')
  @ApiOperation({
    summary: 'Record a payment to a vendor',
    description:
      "Allocated automatically against that vendor's oldest unpaid bills first, in " +
      'one transaction with the bill updates. An amount exceeding everything ' +
      'outstanding is accepted and the remainder recorded as `unallocatedBalance` ' +
      '— paying a vendor in advance is ordinary.',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreatePaymentDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.payments.create(caller, dto, ipAddress, companyId);
  }

  @Post('payments/:id/proof')
  @ApiOperation({
    summary: 'Attach the RTGS advice or transaction confirmation (017 FR-020)',
    description:
      'Closes the gap US7 names: a payment carried a reference number somebody typed ' +
      'and nothing behind it. Re-attaching replaces the current proof and deliberately ' +
      'does not delete the old blob — the first advice is itself a record of what was ' +
      'believed at the time.',
  })
  async attachProof(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AttachPaymentProofDto,
    @Ip() ipAddress: string,
  ) {
    return this.payments.attachProof(
      caller,
      id,
      {
        data: Buffer.from(dto.data, 'base64'),
        contentType: dto.contentType,
      },
      ipAddress,
    );
  }

  @Get('payments/:id/proof')
  @ApiOperation({
    summary: 'Open the proof without leaving the payment (FR-020 scenario 3)',
    description:
      'Audit-logged on read, before the bytes are sent: a payment advice names an ' +
      'account number, and who looked at it is worth knowing (FR-023).',
  })
  async downloadProof(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
    @Res() res: Response,
  ) {
    const { data, contentType } = await this.payments.downloadProof(
      caller,
      id,
      ipAddress,
    );
    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="payment-proof-${id}"`,
    );
    res.send(data);
  }

  @Delete('payments/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a payment and give every bill its allocation back',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    await this.payments.remove(caller, id, ipAddress);
  }
}
