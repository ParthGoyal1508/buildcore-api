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
  CreateServiceScheduleDto,
  ListServiceSchedulesDto,
  UpdateServiceScheduleDto,
} from './dto/service-schedule.dto';
import { ServiceScheduleService } from './service-schedule.service';

/** Service schedules (006 US6), gated by `MAINTENANCE` — one of the two values
 * this feature genuinely adds. */
@ApiTags('Plant')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.MAINTENANCE)
@Controller('plant/services')
export class ServiceScheduleController {
  constructor(private readonly schedules: ServiceScheduleService) {}

  @Get()
  @ApiOperation({
    summary: 'Paginated service schedules with derived status',
    description:
      "Status is computed against the machine's current reading on every read " +
      '(FR-006), so it can never be stale. Filtering by it is resolved before ' +
      'paging, so a filtered page is a full page.',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListServiceSchedulesDto,
  ) {
    return this.schedules.findAll(caller, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a schedule',
    description: '`nextDueReading` is computed as last done + interval.',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateServiceScheduleDto,
    @Ip() ipAddress: string,
  ) {
    return this.schedules.create(caller, dto, ipAddress);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a schedule',
    description: '`nextDueReading` is always recomputed, never accepted.',
  })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateServiceScheduleDto,
    @Ip() ipAddress: string,
  ) {
    return this.schedules.update(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a schedule' })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    await this.schedules.remove(caller, id, ipAddress);
  }
}
