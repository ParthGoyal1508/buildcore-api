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
import { ExportThrottle } from '../../common/throttle/app-throttle';
import { BOCWService } from './bocw.service';
import { CreateBocwPaymentDto, ListBocwQueryDto } from './dto/bocw.dto';

@ApiTags('Partners')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PARTNERS)
@Controller('partners/bocw')
export class BOCWController {
  constructor(private readonly bocw: BOCWService) {}

  @Get()
  @ApiOperation({
    summary: 'Cess liability and balance per project',
    description:
      'Liability, total paid and balance are computed at request time, never stored. ' +
      '`unavailableModules` lists modules this view needs but cannot reach — today ' +
      'that is always `projects`, which feature 008 will provide.',
  })
  async list(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListBocwQueryDto,
  ) {
    // `search` and `status` narrow the rows server-side (042); the shape is unchanged.
    return this.bocw.list(caller, query.companyId, {
      search: query.search,
      status: query.status,
    });
  }

  @Get('export')
  // Every project's liability and payments, rendered to a workbook (036 N6, B9).
  @ExportThrottle()
  @ApiOperation({ summary: 'Cess liability and balance per project, as Excel' })
  async export(
    @UserEntity() caller: AuthenticatedUser,
    @Res() res: Response,
    @Query('companyId') companyId?: string,
  ) {
    const { buffer, filename } = await this.bocw.exportXlsx(caller, companyId);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', contentDispositionFor(filename));
    res.send(buffer);
  }

  @Get(':projectId/payments')
  @ApiOperation({ summary: 'Cess payments recorded against one project' })
  async listPayments(
    @UserEntity() caller: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.bocw.listPayments(caller, projectId, companyId);
  }

  @Post(':projectId/payments')
  @ApiOperation({ summary: 'Record a cess payment against a project' })
  async recordPayment(
    @UserEntity() caller: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Body() dto: CreateBocwPaymentDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.bocw.recordPayment(
      caller,
      projectId,
      dto,
      ipAddress,
      companyId,
    );
  }
}
