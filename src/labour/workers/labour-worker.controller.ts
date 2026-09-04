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
  CreateWorkerDto,
  DeactivateWorkerDto,
  EnrolWorkerFaceDto,
  ListWorkersDto,
} from './dto/worker.dto';
import { LabourWorkerService } from './labour-worker.service';

@ApiTags('Labour')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.DAILY_WORKER_REGISTRY)
@Controller('labour/workers')
export class LabourWorkerController {
  constructor(private readonly workers: LabourWorkerService) {}

  @Get()
  @ApiOperation({ summary: 'Paginated worker list with masked PII (FR-009)' })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListWorkersDto,
  ) {
    return this.workers.findAll(caller, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One worker with masked PII' })
  async findOne(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.workers.findOne(caller, id);
  }

  @Post()
  @ApiOperation({
    summary: 'Register a labour worker',
    description:
      'Contractor engagement requires a resolvable active contractor (FR-008); a ' +
      'duplicate active Aadhaar is rejected with 409 (FR-010).',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateWorkerDto,
    @Ip() ip: string,
  ) {
    return this.workers.create(caller, dto, ip);
  }

  @Patch(':id/deactivate')
  @ApiOperation({
    summary: 'Deactivate a worker, removing them from their gang',
  })
  async deactivate(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DeactivateWorkerDto,
    @Ip() ip: string,
  ) {
    return this.workers.deactivate(caller, id, dto, ip);
  }

  @Post(':id/face-enrolment')
  @ApiOperation({
    summary:
      "Enrol a worker's face, reusing 003's biometric machinery (FR-011)",
  })
  async enrolFace(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: EnrolWorkerFaceDto,
    @Ip() ip: string,
  ) {
    return this.workers.enrolFace(caller, id, dto.photos, ip);
  }
}
