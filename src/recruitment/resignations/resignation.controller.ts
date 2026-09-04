import {
  Body,
  Controller,
  Get,
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
  AcceptResignationDto,
  CreateResignationDto,
  ListResignationsDto,
  WithdrawResignationDto,
} from './dto/resignation.dto';
import { ResignationService } from './resignation.service';

@ApiTags('Recruitment')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.RECRUITMENT)
@Controller('recruitment/resignations')
export class ResignationController {
  constructor(private readonly resignations: ResignationService) {}

  @Get()
  @ApiOperation({ summary: 'List resignations' })
  findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListResignationsDto,
  ) {
    return this.resignations.findAll(caller, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Record a resignation with a computed last working day',
  })
  create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateResignationDto,
    @Ip() ip: string,
  ) {
    return this.resignations.create(caller, dto, ip);
  }

  @Patch(':id/accept')
  @RequirePermissions(Permission.RECRUITMENT_APPROVE)
  @ApiOperation({ summary: 'Accept a resignation (RECRUITMENT_APPROVE)' })
  accept(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AcceptResignationDto,
    @Ip() ip: string,
  ) {
    return this.resignations.accept(caller, id, dto, ip);
  }

  @Patch(':id/withdraw')
  @ApiOperation({ summary: 'Withdraw a resignation' })
  withdraw(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: WithdrawResignationDto,
    @Ip() ip: string,
  ) {
    return this.resignations.withdraw(caller, id, dto.reason, ip);
  }
}
