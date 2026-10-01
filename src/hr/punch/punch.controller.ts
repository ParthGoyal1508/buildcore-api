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
import { SelfService } from '../../common/decorators/route-access.decorator';

@ApiTags('My Workspace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
// 019 FR-005: authorised by ownership, not by a permission — this is an employee's own punches and history,
// resolved from the caller's own user id in the service. Every employee would need
// such a permission, so it would grant nothing; what matters is that the row is
// theirs. Declared rather than left as an absence, so the guard can refuse a route
// that says nothing at all.
@SelfService()
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
  async open(@UserEntity() user: AuthenticatedUser, @Req() request: Request) {
    return this.punch.getTodayPunchState(callerFrom(user, request));
  }

  @Get('exceptions')
  @ApiOperation({
    summary:
      "The caller's own flagged punches and where each approval has got to",
    description:
      'The employee’s side of an attendance exception. This module records the punching ' +
      'employee as the approval’s originator, so an approver who returns an exception ' +
      'for correction returns it to them — and every other approval surface in the ' +
      'product is a reviewer’s. Scoped to the caller’s own employee record; there is ' +
      'deliberately no employee-id parameter (016 FR-005, T042).',
  })
  async exceptions(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.punch.listMyExceptions(callerFrom(user, request), user);
  }

  @Get('refusals')
  @ApiOperation({
    summary: "The caller's own refused punches",
    description:
      'The companion to the 422 a refused punch returns (020 FR-013b). The attempt itself carries ' +
      'its reason in the response, but that response is gone with the screen, and under FR-013d ' +
      'the day reads as a day with no punch — so this is what answers "what happened last ' +
      'Tuesday" without an administrator in the loop.\n\n' +
      'There is deliberately nothing here to resolve, appeal or dismiss. A refused punch is not a ' +
      'work item, because the punch does not exist; the route back is a manual attendance ' +
      'correction, which is reviewed by somebody.',
  })
  async refusals(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.punch.listMyRefusals(callerFrom(user, request));
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
