import {
  BadRequestException,
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
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { formFormatOf, sendForm } from '../../common/form-document';
import { SaveLogbookSheetDto } from './dto/logbook-sheet.dto';
import { LogbookSheetService } from './logbook-sheet.service';
import {
  CorrectLogbookReadingsDto,
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
  constructor(
    private readonly logbook: LogbookService,
    private readonly sheet: LogbookSheetService,
  ) {}

  @Get('sheet')
  @ApiOperation({
    summary:
      'The Vehicle Log Book and Diesel Report Sheet for one machine and month',
    description:
      'Every day of the month with its card no., diesel advance and litres, starting and ' +
      "closing reading and total, the totals, and the month's average (km/l or l/hr).",
  })
  async sheetMonth(
    @UserEntity() caller: AuthenticatedUser,
    @Query('equipmentId') equipmentId: string,
    @Query('month') month: string,
  ) {
    if (!equipmentId) throw new BadRequestException('equipmentId is required');
    return this.sheet.month(caller, equipmentId, month ?? '');
  }

  @Post('sheet')
  @ApiOperation({
    summary: 'Enter days on the log book and diesel sheet',
    description:
      "Each row with readings becomes that day's logbook entry; each row with diesel becomes " +
      'a fuel entry. A day that already has readings is refused (409).',
  })
  async saveSheet(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: SaveLogbookSheetDto,
    @Ip() ipAddress: string,
  ) {
    return this.sheet.save(caller, dto, ipAddress);
  }

  @Get('sheet.:format')
  @ApiOperation({ summary: 'The log book and diesel sheet as PDF or Excel' })
  async sheetDocument(
    @UserEntity() caller: AuthenticatedUser,
    @Param('format') format: string,
    @Query('equipmentId') equipmentId: string,
    @Query('month') month: string,
    @Res() res: Response,
  ) {
    const kind = formFormatOf(format);
    if (!kind) throw new BadRequestException('Format must be pdf or xlsx');
    if (!equipmentId) throw new BadRequestException('equipmentId is required');
    sendForm(
      res,
      await this.sheet.document(caller, equipmentId, month ?? '', kind),
    );
  }

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
      'Readings are not changed here — every derived figure depends on them. ' +
      'Use PATCH :id/readings, which requires a reason (036 K6).',
  })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateLogbookEntryDto,
    @Ip() ipAddress: string,
  ) {
    return this.logbook.update(caller, id, dto, ipAddress);
  }

  @Patch(':id/readings')
  @ApiOperation({
    summary: 'Correct the readings, with a reason (036 K6)',
    description:
      'Same rules as recording the day (closing ≥ opening, ≤ 24 h on an hour meter, a gap needs ' +
      "readingGapReason). 409 inside a verified or paid hire bill. The machine's reading and " +
      'utilisation are re-derived; the audit entry keeps the reason and the readings before and after.',
  })
  async correctReadings(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CorrectLogbookReadingsDto,
    @Ip() ipAddress: string,
  ) {
    return this.logbook.correctReadings(caller, id, dto, ipAddress);
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
