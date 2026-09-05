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
import { ConditionGradesService } from '../../settings/asset-masters/condition-grades.service';
import {
  CreateConditionGradeDto,
  UpdateConditionGradeDto,
} from '../../settings/asset-masters/dto/asset-masters.dto';
import { AssetService } from '../register/asset.service';

/**
 * Condition grades — settings-owned, assets-routed, `SETTINGS`-gated.
 *
 * Read by anyone with `ASSETS` in practice, because a return has to pick one; the
 * read is exposed through the asset detail rather than by loosening this guard, so
 * there is exactly one place a grade can be edited.
 */
@ApiTags('Assets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.SETTINGS)
@Controller('assets/condition-grades')
export class ConditionGradesController {
  constructor(
    private readonly grades: ConditionGradesService,
    private readonly assets: AssetService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Every condition grade, best first' })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query('companyId') companyId?: string,
  ) {
    return this.grades.findAll(caller, companyId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a condition grade' })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateConditionGradeDto,
    @Ip() ipAddress: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.grades.create(caller, dto, ipAddress, companyId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a condition grade' })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateConditionGradeDto,
    @Ip() ipAddress: string,
  ) {
    return this.grades.update(caller, id, dto, ipAddress);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a condition grade',
    description: '409 once anything is graded at it.',
  })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    await this.assets.assertGradeUnused(caller, id);
    await this.grades.remove(caller, id, ipAddress);
  }
}
