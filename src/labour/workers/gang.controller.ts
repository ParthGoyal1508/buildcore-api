import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
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
import { CreateGangDto, ListGangsDto } from './dto/gang.dto';
import { GangService } from './gang.service';

@ApiTags('Labour')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.DAILY_WORKER_REGISTRY)
@Controller('labour/gangs')
export class GangController {
  constructor(private readonly gangs: GangService) {}

  @Get()
  @ApiOperation({ summary: 'List gangs' })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListGangsDto,
  ) {
    return this.gangs.findAll(caller, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One gang with its active members' })
  async findOne(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.gangs.findOne(caller, id);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a gang',
    description:
      'A worker already in another active gang is rejected with 409 (FR-012).',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateGangDto,
    @Ip() ip: string,
  ) {
    return this.gangs.create(caller, dto, ip);
  }
}
