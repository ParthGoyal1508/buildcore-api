import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Patch,
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
import { ListMustersDto, ReturnMusterDto } from './dto/muster.dto';
import { MusterService } from './muster.service';

@ApiTags('Labour')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.DAILY_WORKER_REGISTRY)
@Controller('labour/musters')
export class MusterController {
  constructor(private readonly musters: MusterService) {}

  @Get()
  @ApiOperation({
    summary: 'Muster list / approval queue',
    description:
      'Defaults to submitted, oldest first, with flag counts on each row (US4).',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListMustersDto,
  ) {
    return this.musters.findAll(caller, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Muster detail with per-line applicable rate' })
  async findOne(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.musters.findOne(caller, id);
  }

  @Patch(':id/approve')
  @RequirePermissions(Permission.LABOUR_APPROVE)
  @ApiOperation({ summary: 'Approve a submitted muster (LABOUR_APPROVE)' })
  async approve(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ip: string,
  ) {
    return this.musters.approve(caller, id, ip);
  }

  @Patch(':id/return')
  @RequirePermissions(Permission.LABOUR_APPROVE)
  @ApiOperation({
    summary: 'Return a muster to draft with a reason (LABOUR_APPROVE)',
  })
  async returnToDraft(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReturnMusterDto,
    @Ip() ip: string,
  ) {
    return this.musters.returnToDraft(caller, id, dto.reason, ip);
  }
}
