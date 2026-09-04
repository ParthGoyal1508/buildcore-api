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
  DisburseLineDto,
  GeneratePaymentSheetDto,
  ListPaymentSheetsDto,
  ReopenPaymentSheetDto,
  ReverseLineDto,
} from './dto/payment-sheet.dto';
import { PaymentSheetService } from './payment-sheet.service';

@ApiTags('Labour')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.DAILY_WORKER_REGISTRY)
@Controller('labour/payment-sheets')
export class PaymentSheetController {
  constructor(private readonly sheets: PaymentSheetService) {}

  @Get()
  @ApiOperation({ summary: 'List payment sheets' })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListPaymentSheetsDto,
  ) {
    return this.sheets.findAll(caller, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Payment sheet detail with per-line figures and summary',
  })
  async findOne(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.sheets.findOne(caller, id);
  }

  @Get(':id/denominations')
  @ApiOperation({
    summary: 'Cash denomination breakup for an approved direct sheet (FR-027)',
  })
  async denominations(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.sheets.getDenominations(caller, id);
  }

  @Post()
  @ApiOperation({
    summary: 'Generate a draft sheet from approved musters',
    description:
      'A worked date with no applicable rate fails with 409 naming the project, ' +
      'skill category and date (FR-007); an overlapping period is rejected (FR-023).',
  })
  async generate(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: GeneratePaymentSheetDto,
    @Ip() ip: string,
  ) {
    return this.sheets.generate(caller, dto, ip);
  }

  @Patch(':id/approve')
  @RequirePermissions(Permission.LABOUR_APPROVE)
  @ApiOperation({ summary: 'Approve and freeze a sheet (LABOUR_APPROVE)' })
  async approve(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ip: string,
  ) {
    return this.sheets.approve(caller, id, ip);
  }

  @Patch(':id/reopen')
  @RequirePermissions(Permission.LABOUR_APPROVE)
  @ApiOperation({
    summary: 'Reopen an approved sheet to draft (LABOUR_APPROVE)',
    description: 'Blocked once any line is disbursed (FR of US5).',
  })
  async reopen(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReopenPaymentSheetDto,
    @Ip() ip: string,
  ) {
    return this.sheets.reopen(caller, id, dto.reason, ip);
  }

  @Patch('lines/:lineId/disburse')
  @ApiOperation({
    summary: 'Disburse a payment line',
    description:
      'Cash requires an acknowledgement image (FR-029); bank requires a recorded ' +
      'account; a short payment requires a reason and carries forward (FR-030).',
  })
  async disburse(
    @UserEntity() caller: AuthenticatedUser,
    @Param('lineId') lineId: string,
    @Body() dto: DisburseLineDto,
    @Ip() ip: string,
  ) {
    return this.sheets.disburseLine(caller, lineId, dto, ip);
  }

  @Patch('lines/:lineId/reverse')
  @RequirePermissions(Permission.LABOUR_APPROVE)
  @ApiOperation({
    summary: 'Reverse a disbursed line (LABOUR_APPROVE)',
    description:
      'Reverses the advance recovery; blocked on a closed sheet (FR-031).',
  })
  async reverse(
    @UserEntity() caller: AuthenticatedUser,
    @Param('lineId') lineId: string,
    @Body() dto: ReverseLineDto,
    @Ip() ip: string,
  ) {
    return this.sheets.reverseLine(caller, lineId, dto.reason, ip);
  }
}
