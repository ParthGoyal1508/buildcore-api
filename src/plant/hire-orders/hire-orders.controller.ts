import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import { formFormatOf, sendForm } from '../../common/form-document';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CreateHireOrderDto, UpdateHireOrderDto } from './dto/hire-order.dto';
import { HireOrdersService } from './hire-orders.service';

/** Vehicle work/hire orders (2026-10-15), under the machinery permission. */
@ApiTags('Plant')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.MACHINERY)
@Controller('plant/hire-orders')
export class HireOrdersController {
  constructor(private readonly orders: HireOrdersService) {}

  @Get()
  @ApiOperation({ summary: 'Hire orders, newest first' })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query('companyId') companyId?: string,
    @Query('vendorId') vendorId?: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.orders.findAll(caller, { companyId, vendorId, projectId });
  }

  @Get(':id/document.:format')
  @ApiOperation({
    summary:
      "The order in the client's WORK/HIRE ORDER format — PDF, Word or Excel",
  })
  async document(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Param('format') format: string,
    @Res() res: Response,
  ) {
    const kind = formFormatOf(format, ['pdf', 'docx', 'xlsx']);
    if (!kind)
      throw new BadRequestException('Format must be pdf, docx or xlsx');
    sendForm(res, await this.orders.document(caller, id, kind));
  }

  @Get(':id')
  async findOne(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.orders.findOne(caller, id);
  }

  @Post()
  @ApiOperation({
    summary: 'Raise a hire order',
    description: 'Numbered from the work-order series in Settings → Numbering.',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateHireOrderDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.orders.create(caller, dto, companyId);
  }

  @Patch(':id')
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateHireOrderDto,
  ) {
    return this.orders.update(caller, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    await this.orders.remove(caller, id);
  }
}
