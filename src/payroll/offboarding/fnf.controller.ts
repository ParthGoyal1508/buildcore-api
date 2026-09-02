import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { callerFrom } from '../../hr/caller-context';
import { InitiateExitDto, ProcessFnfDto } from '../../hr/offboarding/dto/exit.dto';
import { ExitService } from '../../hr/offboarding/exit.service';
import { FnfService } from './fnf.service';

/**
 * Offboarding and Full & Final settlement (005 US11).
 *
 * Nested under the employee because both acts are about one person, and the exit
 * record is what the settlement is computed against.
 */
@ApiTags('HR — Employees')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.EMPLOYEES)
@Controller('hr/employees/:employeeId')
export class FnfController {
  constructor(
    private readonly exits: ExitService,
    private readonly fnf: FnfService,
  ) {}

  @Post('exit')
  @ApiOperation({
    summary: 'Initiate an exit',
    description:
      'The employee stays active until the F&F is processed — they may still be ' +
      'working a notice period, and that attendance feeds the settlement.',
  })
  @ApiResponse({ status: 409, description: 'An exit is already in progress.' })
  async initiate(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('employeeId') employeeId: string,
    @Body() dto: InitiateExitDto,
  ) {
    return this.exits.initiate(callerFrom(user, request), employeeId, dto);
  }

  @Get('exit')
  @ApiOperation({ summary: 'The employee’s most recent exit record, if any' })
  async getExit(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('employeeId') employeeId: string,
  ) {
    return this.exits.getOpen(callerFrom(user, request), employeeId);
  }

  @Get('fnf')
  @ApiOperation({
    summary: 'Compute the settlement without persisting anything',
    description:
      'Pending salary pro-rated to the last working day, earned-leave ' +
      'encashment, and loan recovery. Returns warnings worth seeing before ' +
      'processing an irreversible run.',
  })
  @ApiResponse({ status: 400, description: 'No exit initiated.' })
  async computeFnf(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('employeeId') employeeId: string,
  ) {
    return this.fnf.compute(callerFrom(user, request), employeeId);
  }

  @Post('fnf/process')
  @ApiOperation({
    summary: 'Persist the settlement as an F&F payroll run (Draft)',
    description:
      'Creates a normal PayrollRun flagged isFnf, so it inherits the standard ' +
      'Draft → Processed → Paid lifecycle. Processing that run is what ' +
      'deactivates the employee.',
  })
  @ApiResponse({ status: 409, description: 'Already settled.' })
  async processFnf(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('employeeId') employeeId: string,
    @Body() dto: ProcessFnfDto,
  ) {
    return this.fnf.process(callerFrom(user, request), employeeId, dto.period);
  }
}
