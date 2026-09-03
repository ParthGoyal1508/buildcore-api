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
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { ComplianceService } from './compliance.service';
import {
  CreateComplianceDto,
  ListComplianceDto,
  UpdateComplianceDto,
} from './dto/compliance.dto';

@ApiTags('Partners')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PARTNERS)
@Controller('partners/compliance')
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Get()
  @ApiOperation({
    summary: 'Monthly PF/ESIC filings, filterable by contractor or month',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListComplianceDto,
  ) {
    return this.compliance.findAll(caller, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Record a month’s filing',
    description:
      'Status is derived from which challans are present and cannot be set directly: ' +
      'both is `submitted`, one is `partial`, neither is `missing`.',
  })
  @ApiConflictResponse({
    description: 'A record for that month already exists',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateComplianceDto,
    @Ip() ipAddress: string,
  ) {
    return this.compliance.create(caller, dto, ipAddress);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Correct a filing that has not been verified' })
  @ApiConflictResponse({
    description: 'The record is verified and is now immutable',
  })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateComplianceDto,
    @Ip() ipAddress: string,
  ) {
    return this.compliance.update(caller, id, dto, ipAddress);
  }

  @Patch(':id/verify')
  @ApiOperation({
    summary: 'Mark a submitted filing as verified',
    description:
      'Only a submitted record can be verified. Verification is a human assertion ' +
      'that the challans were checked, so it is recorded against the caller and the ' +
      'record becomes immutable.',
  })
  @ApiConflictResponse({
    description: 'The record is not submitted, or is already verified',
  })
  async verify(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    return this.compliance.verify(caller, id, ipAddress);
  }
}
