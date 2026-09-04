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
  CreateLogbookEntryDto,
  ListLogbookDto,
  UpdateLogbookEntryDto,
} from './dto/logbook.dto';
import { LogbookService } from './logbook.service';

/** The daily logbook (006 US3), gated by the `LOGBOOK` value 002 already reserved. */
@ApiTags('Plant')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.LOGBOOK)
@Controller('plant/logbook')
export class LogbookController {
  constructor(private readonly logbook: LogbookService) {}

  @Get()
  @ApiOperation({ summary: 'Paginated logbook entries' })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListLogbookDto,
  ) {
    return this.logbook.findAll(caller, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Record a day',
    description:
      '400 if the closing reading is below the opening one; 409 if the machine ' +
      "already has an entry for that date. Updates the machine's reading and " +
      'utilisation in the same transaction.',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateLogbookEntryDto,
    @Ip() ipAddress: string,
  ) {
    return this.logbook.create(caller, dto, ipAddress);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Correct fuel, operator or remarks',
    description:
      'Readings are immutable once recorded — every derived figure depends on ' +
      'them. Delete and re-record to correct one.',
  })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateLogbookEntryDto,
    @Ip() ipAddress: string,
  ) {
    return this.logbook.update(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an entry',
    description:
      "Re-derives the machine's reading and utilisation from what remains.",
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    await this.logbook.remove(caller, id, ipAddress);
  }
}
