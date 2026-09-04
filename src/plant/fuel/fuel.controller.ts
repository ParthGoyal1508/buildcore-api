import {
  Body,
  Controller,
  Get,
  Ip,
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
  CreateFuelEntryDto,
  FuelSummaryDto,
  ListFuelDto,
} from './dto/fuel.dto';
import { FuelService } from './fuel.service';

/** Fuel entries and variance alerts (006 US4), gated by `FUEL`. */
@ApiTags('Plant')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.FUEL)
@Controller('plant/fuel')
export class FuelController {
  constructor(private readonly fuel: FuelService) {}

  // Declared before the parameterless `GET /` handler would matter — Nest matches
  // in declaration order, and `summary` must not be read as a filter value.
  @Get('summary')
  @ApiOperation({ summary: 'Per-machine fuel totals for one calendar month' })
  async summary(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: FuelSummaryDto,
  ) {
    return this.fuel.getMonthlySummary(caller, query);
  }

  @Get()
  @ApiOperation({ summary: 'Paginated fuel entries' })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListFuelDto,
  ) {
    return this.fuel.findAll(caller, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Record a fuel entry',
    description:
      "Computes amount and variance against the machine category's own configured " +
      'threshold, and emits a `fuel_variance` event when it is exceeded.',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateFuelEntryDto,
    @Ip() ipAddress: string,
  ) {
    return this.fuel.create(caller, dto, ipAddress);
  }
}
