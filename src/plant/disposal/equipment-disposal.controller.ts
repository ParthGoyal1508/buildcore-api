import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
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
import { contentDispositionFor } from '../../common/storage/file-type';
import {
  DisposalPreviewDto,
  DisposeEquipmentDto,
  ListDisposalsDto,
  ReverseDisposalDto,
} from './dto/disposal.dto';
import { EquipmentDisposalService } from './equipment-disposal.service';

/**
 * Scrapping and selling machines (2026-10-17). Reading needs `MACHINERY`, like the rest of the
 * fleet; disposing and reversing need `MACHINERY_DISPOSE`, held by Super Admin only.
 */
@ApiTags('Plant & Machinery')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.MACHINERY)
@Controller('plant')
export class EquipmentDisposalController {
  constructor(private readonly disposals: EquipmentDisposalService) {}

  @Get('equipment/:id/disposal')
  @ApiOperation({ summary: 'The disposal in force for a machine, or null' })
  async current(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.disposals.current(caller, id);
  }

  @Get('equipment/:id/disposal/preview')
  @ApiOperation({
    summary: 'Book value on a date and the site a disposal would release',
  })
  async preview(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Query() query: DisposalPreviewDto,
  ) {
    return this.disposals.preview(caller, id, query.disposalDate);
  }

  @Get('equipment/:id/history')
  @ApiOperation({ summary: "The machine's history, newest first" })
  async history(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.disposals.history(caller, id);
  }

  @Post('equipment/:id/dispose')
  @RequirePermissions(Permission.MACHINERY_DISPOSE)
  @ApiOperation({
    summary: 'Mark a machine as scrapped or sold',
    description:
      'Releases it from its site if deployed, takes it out of every working list, and records ' +
      'both in its history.',
  })
  async dispose(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DisposeEquipmentDto,
    @Ip() ip: string,
  ) {
    return this.disposals.dispose(caller, id, dto, ip);
  }

  @Post('equipment/:id/disposal/reverse')
  @RequirePermissions(Permission.MACHINERY_DISPOSE)
  @ApiOperation({
    summary: 'Reverse a disposal made by mistake, with a reason',
  })
  async reverse(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReverseDisposalDto,
    @Ip() ip: string,
  ) {
    return this.disposals.reverse(caller, id, dto.reason, ip);
  }

  @Get('disposals')
  @ApiOperation({
    summary: 'Scrapped & Sold Machines: summary, chart and table',
  })
  async list(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListDisposalsDto,
  ) {
    return this.disposals.list(caller, query);
  }

  @Get('disposals/export')
  @ApiOperation({ summary: 'The filtered disposals as Excel' })
  async export(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListDisposalsDto,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.disposals.exportXlsx(caller, query);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', contentDispositionFor(filename));
    res.send(buffer);
  }

  @Get('disposals/:id')
  @ApiOperation({ summary: 'One disposal record' })
  async findOne(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.disposals.findOne(caller, id);
  }

  @Get('disposals/:id/attachment')
  @ApiOperation({ summary: "The disposal's attachment" })
  async attachment(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const file = await this.disposals.attachment(caller, id);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', contentDispositionFor(file.fileName));
    res.send(file.buffer);
  }
}
