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
  CreateHireRateDto,
  ListHireRatesDto,
} from '../../settings/machinery-masters/dto/machinery-masters.dto';
import { HireRatesService } from '../../settings/machinery-masters/hire-rates.service';

/**
 * Hire rates — a `settings` master on a `/plant` route.
 *
 * There is no PATCH. A rate is a fact about a period, and editing one would
 * retroactively reprice every hire bill raised under it. Change the rate by adding
 * a new one from the date it takes effect; the prior rate closes automatically
 * (FR-014).
 */
@ApiTags('Plant')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.SETTINGS)
@Controller('plant/rates')
export class HireRatesController {
  constructor(private readonly rates: HireRatesService) {}

  @Get()
  @ApiOperation({
    summary: 'Effective-dated hire rate history',
    description: 'Newest first. A null `effectiveTo` is the rate in force now.',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListHireRatesDto,
  ) {
    return this.rates.findAll(caller, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Add a hire rate',
    description:
      "Closes the prior current rate's effectiveTo to the day before this one " +
      'starts, so the timeline never overlaps (FR-014).',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateHireRateDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.rates.create(caller, dto, ipAddress, companyId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove the most recent hire rate',
    description:
      'Only the latest rate can be removed, and doing so reopens its predecessor. ' +
      '409 for anything in the middle of the timeline — that would leave a gap no ' +
      'bill could resolve.',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    await this.rates.remove(caller, id, ipAddress);
  }
}
