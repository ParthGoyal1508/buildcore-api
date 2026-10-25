import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { contentDispositionFor } from '../../common/storage/file-type';
import { ExportThrottle } from '../../common/throttle/app-throttle';
import { RagMatrixQueryDto } from './dto/rag-query.dto';
import { RagService } from './rag.service';

@ApiTags('Partners')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PARTNERS)
@Controller('partners/rag')
export class RagController {
  constructor(private readonly rag: RagService) {}

  @Get()
  @ApiOperation({
    summary: 'Compliance matrix for one financial year',
    description:
      'Months later than the current one are `gray` rather than `missing` — a filing ' +
      'that is not yet due has not been missed.',
  })
  async matrix(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: RagMatrixQueryDto,
  ) {
    // `search` and `status` narrow the rows server-side (042); the shape is unchanged.
    return this.rag.buildMatrix(caller, query.fy, query.companyId, {
      search: query.search,
      status: query.status,
    });
  }

  @Get('export')
  // A whole year's matrix per call, rendered to a workbook (036 N6, B9).
  @ExportThrottle()
  @ApiOperation({
    summary: 'The compliance matrix for one financial year, as Excel',
  })
  @ApiQuery({ name: 'fy', example: '2025-26' })
  async export(
    @UserEntity() caller: AuthenticatedUser,
    @Query('fy') fy: string,
    @Res() res: Response,
    @Query('companyId') companyId?: string,
  ) {
    const { buffer, filename } = await this.rag.exportXlsx(
      caller,
      fy,
      companyId,
    );
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', contentDispositionFor(filename));
    res.send(buffer);
  }
}
