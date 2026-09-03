import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
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
  @ApiQuery({ name: 'fy', example: '2025-26' })
  async matrix(
    @UserEntity() caller: AuthenticatedUser,
    @Query('fy') fy: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.rag.buildMatrix(caller, fy, companyId);
  }
}
