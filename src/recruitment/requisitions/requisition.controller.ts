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
import {
  CreateRequisitionDto,
  ListRequisitionsDto,
  RejectRequisitionDto,
} from './dto/requisition.dto';
import { RequisitionService } from './requisition.service';

@ApiTags('Recruitment')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.RECRUITMENT)
@Controller('recruitment/requisitions')
export class RequisitionController {
  constructor(private readonly requisitions: RequisitionService) {}

  @Get()
  @ApiOperation({ summary: 'Paginated requisition list (Open Positions)' })
  findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListRequisitionsDto,
  ) {
    return this.requisitions.findAll(caller, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One requisition' })
  findOne(@UserEntity() caller: AuthenticatedUser, @Param('id') id: string) {
    return this.requisitions.findOne(caller, id);
  }

  @Post()
  @ApiOperation({ summary: 'Raise a requisition' })
  create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateRequisitionDto,
    @Ip() ip: string,
  ) {
    return this.requisitions.create(caller, dto, ip);
  }

  @Patch(':id/submit')
  @ApiOperation({ summary: 'Submit for approval' })
  submit(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ip: string,
  ) {
    return this.requisitions.submit(caller, id, ip);
  }

  @Patch(':id/approve')
  @RequirePermissions(Permission.RECRUITMENT_APPROVE)
  @ApiOperation({ summary: 'Approve a requisition (RECRUITMENT_APPROVE)' })
  approve(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ip: string,
  ) {
    return this.requisitions.approve(caller, id, ip);
  }

  @Patch(':id/reject')
  @RequirePermissions(Permission.RECRUITMENT_APPROVE)
  @ApiOperation({
    summary: 'Reject a requisition with a reason (RECRUITMENT_APPROVE)',
  })
  reject(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RejectRequisitionDto,
    @Ip() ip: string,
  ) {
    return this.requisitions.reject(caller, id, dto.reason, ip);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a requisition (blocked when candidates exist)',
  })
  remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ip: string,
  ) {
    return this.requisitions.remove(caller, id, ip);
  }
}
