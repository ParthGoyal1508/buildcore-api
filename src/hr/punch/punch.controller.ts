import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { UserEntity } from '../../common/decorators/user.decorator';
import { callerFrom } from '../caller-context';
import {
  AttendanceMonth,
  AttendanceHistoryService,
} from './attendance-history.service';
import {
  AttendanceHistoryQueryDto,
  PunchResultDto,
  SubmitPunchDto,
} from './dto/punch.dto';
import { PunchService } from './punch.service';

@ApiTags('My Workspace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('my/punch')
export class PunchController {
  constructor(
    private readonly punch: PunchService,
    private readonly attendanceHistory: AttendanceHistoryService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit a punch in/out for the caller' })
  @ApiResponse({
    status: 201,
    description:
      'Punch recorded. Returned even when face matching or the geofence check produced an exception — the punch is recorded either way and routed to an admin (FR-007).',
    type: PunchResultDto,
  })
  @ApiResponse({
    status: 423,
    description: 'The punch date falls in an already-locked payroll period.',
  })
  async submit(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Body() dto: SubmitPunchDto,
  ): Promise<PunchResultDto> {
    return this.punch.submitPunch(callerFrom(user, request), dto);
  }

  @Get('open')
  @ApiOperation({
    summary: "The caller's punch state for today, and whether it is complete",
  })
  async open(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.punch.getTodayPunchState(callerFrom(user, request));
  }

  @Get('history')
  @ApiOperation({ summary: "The caller's own attendance for one month" })
  @ApiResponse({
    status: 200,
    description:
      'Every date in the month with its computed status. A month with no activity returns days marked absent/weekly off/holiday rather than an error (FR-011).',
  })
  async history(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query() query: AttendanceHistoryQueryDto,
  ): Promise<AttendanceMonth> {
    return this.attendanceHistory.getMonthHistory(
      callerFrom(user, request),
      query.month,
      query.year,
    );
  }
}
