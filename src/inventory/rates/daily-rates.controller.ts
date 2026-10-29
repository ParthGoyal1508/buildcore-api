import {
  Body,
  Controller,
  Get,
  Ip,
  Put,
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
import { DailyRatesService } from './daily-rates.service';
import {
  DailyRateBoardQueryDto,
  DailyRateHistoryQueryDto,
  EffectiveDailyRateQueryDto,
  SetDailyRatesDto,
} from './dto/daily-rate.dto';

/**
 * Daily-changing item rates (050). `INVENTORY`, the area that records purchases and so governs the
 * rates they are bought at: read to see or be offered a rate, write to set one.
 */
@ApiTags('Inventory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.INVENTORY)
@Controller('inventory/daily-rates')
export class DailyRatesController {
  constructor(private readonly rates: DailyRatesService) {}

  @Get()
  @ApiOperation({
    summary:
      "Update today's rates: every daily-rate item, its market rate and vendors, as in force on a date",
  })
  board(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: DailyRateBoardQueryDto,
  ) {
    return this.rates.board(caller, query);
  }

  @Put()
  @ApiOperation({
    summary:
      "Set one day's rates — market and vendor overrides; null removes that day's row",
  })
  set(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: SetDailyRatesDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.rates.set(caller, dto, ipAddress, companyId);
  }

  @Get('effective')
  @ApiOperation({
    summary: 'The rate offered for an item (and vendor) on a document date',
    description:
      '`{ dailyRate: false }` when the item is not a daily-rate item or has no rate yet.',
  })
  effective(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: EffectiveDailyRateQueryDto,
  ) {
    return this.rates.effectiveFor(caller, query);
  }

  @Get('history')
  @ApiOperation({ summary: "One item's dated rates, newest first" })
  history(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: DailyRateHistoryQueryDto,
  ) {
    return this.rates.history(caller, query);
  }
}
