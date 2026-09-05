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
import { InterviewService } from './interview.service';
import {
  InterviewFeedbackDto,
  ListInterviewsDto,
  RescheduleInterviewDto,
  ScheduleInterviewDto,
} from './dto/interview.dto';

@ApiTags('Recruitment')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.RECRUITMENT)
@Controller('recruitment')
export class InterviewController {
  constructor(private readonly interviews: InterviewService) {}

  @Get('interviews')
  @ApiOperation({ summary: 'Interviews with Today / Upcoming / Overdue flags' })
  findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListInterviewsDto,
  ) {
    return this.interviews.findAll(caller, query);
  }

  @Post('candidates/:id/interviews')
  @ApiOperation({ summary: 'Schedule an interview round' })
  schedule(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') candidateId: string,
    @Body() dto: ScheduleInterviewDto,
    @Ip() ip: string,
  ) {
    return this.interviews.schedule(caller, candidateId, dto, ip);
  }

  @Patch('interviews/:id/feedback')
  @ApiOperation({ summary: 'Record an interviewer feedback' })
  feedback(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: InterviewFeedbackDto,
    @Ip() ip: string,
  ) {
    return this.interviews.submitFeedback(caller, id, dto, ip);
  }

  @Patch('interviews/:id/reschedule')
  @ApiOperation({ summary: 'Reschedule an interview, retaining history' })
  reschedule(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RescheduleInterviewDto,
    @Ip() ip: string,
  ) {
    return this.interviews.reschedule(caller, id, dto, ip);
  }
}
