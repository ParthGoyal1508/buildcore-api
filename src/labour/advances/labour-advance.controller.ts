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
import { CreateAdvanceDto, ListAdvancesDto } from './dto/advance.dto';
import { LabourAdvanceService } from './labour-advance.service';

@ApiTags('Labour')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.DAILY_WORKER_REGISTRY)
@Controller('labour/advances')
export class LabourAdvanceController {
  constructor(private readonly advances: LabourAdvanceService) {}

  @Get()
  @ApiOperation({ summary: 'List labour advances with outstanding balances' })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListAdvancesDto,
  ) {
    return this.advances.findAll(caller, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Advance detail with recovery history' })
  async findOne(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.advances.findOne(caller, id);
  }

  @Post()
  @ApiOperation({
    summary: 'Grant an advance',
    description:
      'An amount above the configured multiple of the daily rate is flagged ' +
      'exceedsLimit and needs LABOUR_APPROVE to approve (US7).',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateAdvanceDto,
    @Ip() ip: string,
  ) {
    return this.advances.create(caller, dto, ip);
  }

  @Patch(':id/approve')
  @RequirePermissions(Permission.LABOUR_APPROVE)
  @ApiOperation({ summary: 'Approve an advance (LABOUR_APPROVE)' })
  async approve(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ip: string,
  ) {
    return this.advances.approve(caller, id, ip);
  }

  @Patch(':id/disburse')
  @RequirePermissions(Permission.LABOUR_APPROVE)
  @ApiOperation({ summary: 'Disburse an approved advance (LABOUR_APPROVE)' })
  async disburse(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ip: string,
  ) {
    return this.advances.disburse(caller, id, ip);
  }
}
