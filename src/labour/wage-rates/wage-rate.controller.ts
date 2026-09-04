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
  CreateWageRateDto,
  ListWageRatesDto,
  UpdateWageRateDto,
} from './dto/wage-rate.dto';
import { WageRateService } from './wage-rate.service';

@ApiTags('Labour')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.DAILY_WORKER_REGISTRY)
@Controller('labour/wage-rates')
export class WageRateController {
  constructor(private readonly wageRates: WageRateService) {}

  @Get()
  @ApiOperation({
    summary: 'Wage-rate history, optionally as-of a date',
    description:
      'Without `asOf`, the full effective-dated history; with it, only rates in ' +
      'force on that date (FR-007/US1).',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListWageRatesDto,
  ) {
    return this.wageRates.findAll(caller, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Append a new per-project, per-skill wage rate',
    description:
      'Closes the prior open-ended rate automatically; backdating before an ' +
      'existing rate is rejected with 400 (FR-004).',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateWageRateDto,
    @Ip() ip: string,
  ) {
    return this.wageRates.create(caller, dto, ip);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit a rate that has not yet priced approved attendance',
    description:
      'Rejected with 409 once the rate has priced an approved muster (FR-005).',
  })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateWageRateDto,
    @Ip() ip: string,
  ) {
    return this.wageRates.update(caller, id, dto, ip);
  }
}
