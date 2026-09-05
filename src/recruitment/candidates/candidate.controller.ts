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
import { CandidateService } from './candidate.service';
import {
  CreateCandidateDto,
  ListCandidatesDto,
  MarkNoShowDto,
  RejectCandidateDto,
  TransitionStageDto,
  UploadResumeDto,
} from './dto/candidate.dto';

@ApiTags('Recruitment')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.RECRUITMENT)
@Controller('recruitment/candidates')
export class CandidateController {
  constructor(private readonly candidates: CandidateService) {}

  @Get()
  @ApiOperation({ summary: 'Pipeline list with masked PII (FR-006)' })
  findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListCandidatesDto,
  ) {
    return this.candidates.findAll(caller, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Unmasked candidate detail (audit-logged READ)' })
  findOne(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ip: string,
  ) {
    return this.candidates.findOne(caller, id, ip);
  }

  @Post()
  @ApiOperation({ summary: 'Add a candidate to an open requisition' })
  create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateCandidateDto,
    @Ip() ip: string,
  ) {
    return this.candidates.create(caller, dto, ip);
  }

  @Post(':id/resume')
  @ApiOperation({ summary: 'Upload a resume (encrypted object storage)' })
  uploadResume(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UploadResumeDto,
    @Ip() ip: string,
  ) {
    return this.candidates.uploadResume(
      caller,
      id,
      dto.file,
      dto.contentType,
      ip,
    );
  }

  @Patch(':id/stage')
  @ApiOperation({ summary: 'Advance a candidate through the pipeline' })
  transition(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: TransitionStageDto,
    @Ip() ip: string,
  ) {
    return this.candidates.transitionStage(
      caller,
      id,
      dto.stage,
      dto.remarks,
      ip,
    );
  }

  @Patch(':id/reject')
  @ApiOperation({ summary: 'Reject a candidate' })
  reject(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RejectCandidateDto,
    @Ip() ip: string,
  ) {
    return this.candidates.reject(caller, id, dto.rejectionReason, ip);
  }

  @Patch(':id/mark-no-show')
  @RequirePermissions(Permission.RECRUITMENT_APPROVE)
  @ApiOperation({
    summary: 'Mark a Joining Pending candidate no-show (RECRUITMENT_APPROVE)',
  })
  markNoShow(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: MarkNoShowDto,
    @Ip() ip: string,
  ) {
    return this.candidates.markNoShow(caller, id, dto.reason, ip);
  }
}
