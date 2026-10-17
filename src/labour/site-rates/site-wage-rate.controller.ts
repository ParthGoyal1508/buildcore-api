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
  CreateSiteWageRateDto,
  ListSiteWageRatesDto,
  UpdateSiteWageRateDto,
} from './dto/site-wage-rate.dto';
import { SiteWageRateService } from './site-wage-rate.service';

/** Site × gender daily rates (031). Read by anyone in the labour module; set by the HR office. */
@ApiTags('Labour')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.DAILY_WORKER_REGISTRY, Permission.LABOUR_APPROVE)
@Controller('labour/site-rates')
export class SiteWageRateController {
  constructor(private readonly rates: SiteWageRateService) {}

  @Get()
  @ApiOperation({ summary: 'Site male/female daily rates, newest first' })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListSiteWageRatesDto,
  ) {
    return this.rates.findAll(caller, query);
  }

  @Post()
  @RequirePermissions(Permission.LABOUR_APPROVE)
  @ApiOperation({
    summary: "Set a site's male and/or female daily rate from a date",
    description:
      'Appended forward: the previous rate for the same site and gender closes the day before.',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateSiteWageRateDto,
    @Ip() ip: string,
  ) {
    return this.rates.create(caller, dto, ip);
  }

  @Patch(':id')
  @RequirePermissions(Permission.LABOUR_APPROVE)
  @ApiOperation({
    summary: 'Correct a rate (409 once an approved payment sheet used it)',
  })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateSiteWageRateDto,
    @Ip() ip: string,
  ) {
    return this.rates.update(caller, id, dto, ip);
  }
}
