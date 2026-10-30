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
import {
  ProjectLockFrom,
  ProjectLockGuard,
} from '../guards/project-lock.guard';
import { ClientReceiptsService } from './client-receipts.service';
import {
  RecordClientHoldReleaseDto,
  RecordClientReceiptDto,
} from './dto/client-receipt.dto';

/**
 * Money a client paid against a bill, with the retention and CPBG it held back (048).
 *
 * `PROJECT_FINANCIALS`, like the bills themselves. A locked project refuses new receipts, as it
 * refuses every other money write.
 */
@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PROJECT_FINANCIALS)
@Controller('projects/client-bills/:id/receipts')
export class ClientReceiptsController {
  constructor(private readonly receipts: ClientReceiptsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Receipts against a client bill, what it is worth and what is outstanding',
    description:
      'Also the suggested retention and CPBG for the next receipt — the bill’s own retention ' +
      '(or the project’s term) and the project’s CPBG term, less what was already withheld — and ' +
      'whether a PBG is running, in which case CPBG is suggested at nil.',
  })
  async list(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') billId: string,
  ) {
    return this.receipts.forBill(rlsContextFor(caller), billId);
  }

  @Post()
  @UseGuards(ProjectLockGuard)
  @ProjectLockFrom('clientBill')
  @ApiOperation({ summary: 'Record money received from the client' })
  @ApiResponse({
    status: 400,
    description:
      '`CLIENT_RECEIPT_BILL_DRAFT`, `CLIENT_RECEIPT_EXCEEDS_BILL`, `CLIENT_RECEIPT_EMPTY`.',
  })
  async record(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') billId: string,
    @Body() dto: RecordClientReceiptDto,
    @Ip() ipAddress: string,
  ) {
    return this.receipts.record(rlsContextFor(caller), billId, dto, {
      userId: caller.id,
      ipAddress,
    });
  }

  @Delete(':receiptId')
  @UseGuards(ProjectLockGuard)
  @ProjectLockFrom('clientBill')
  @ApiOperation({ summary: 'Remove a receipt entered in error (audited)' })
  @ApiResponse({
    status: 409,
    description:
      '`CLIENT_RECEIPT_RELEASED_AGAINST` — its withheld money has already been released.',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') billId: string,
    @Param('receiptId') receiptId: string,
    @Ip() ipAddress: string,
  ) {
    return this.receipts.remove(rlsContextFor(caller), billId, receiptId, {
      userId: caller.id,
      ipAddress,
    });
  }
}

/** What the client is holding of ours on one project, and its releases (048). */
@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PROJECT_FINANCIALS)
@Controller('projects/:id/client-holdings')
export class ClientHoldingsController {
  constructor(private readonly receipts: ClientReceiptsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Retention and CPBG held by the client, with releases and running PBGs',
    description:
      'Derived from receipts and releases, never stored. `cpbgRefundDue` is true while CPBG is ' +
      'still held and a PBG for the project is running — the cash deduction should come back.',
  })
  async get(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') projectId: string,
  ) {
    return this.receipts.holdings(rlsContextFor(caller), projectId);
  }

  @Post('releases')
  @UseGuards(ProjectLockGuard)
  @ApiOperation({
    summary: 'Record retention released or CPBG refunded by the client',
  })
  @ApiResponse({
    status: 400,
    description:
      '`CLIENT_HOLD_RELEASE_EXCEEDS_HELD`, `CLIENT_HOLD_RELEASE_GUARANTEE_MISMATCH`.',
  })
  async release(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') projectId: string,
    @Body() dto: RecordClientHoldReleaseDto,
    @Ip() ipAddress: string,
  ) {
    return this.receipts.release(rlsContextFor(caller), projectId, dto, {
      userId: caller.id,
      ipAddress,
    });
  }
}
