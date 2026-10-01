import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { Permission } from '@prisma/client';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { rlsContextFor } from '../../common/prisma/rls-context';
import { AssignLocationDto } from './dto/location-assignment.dto';
import { LocationAssignmentsService } from './location-assignments.service';

/**
 * Where an employee may punch, and the history of that decision (020 FR-011, FR-014, FR-016).
 *
 * `EMPLOYEES`, like the rest of the employee record. Under 019's level model the read needs read and
 * the write needs write, derived from the verb — which is right here: assigning somebody to the wrong
 * site denies them their pay.
 */
@ApiTags('HR — Location assignments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.EMPLOYEES)
@Controller('hr/employees/:employeeId/location-assignments')
export class LocationAssignmentsController {
  constructor(private readonly assignments: LocationAssignmentsService) {}

  @Get()
  @ApiOperation({
    summary:
      "Which location this employee's punches validate against, and its history",
    description:
      'Newest effective date first. An **empty list is not a misconfiguration** — it means the ' +
      "employee is validated against their own site's geofence, which is the behaviour every " +
      'employee has today (FR-016).',
  })
  async history(
    @UserEntity() caller: AuthenticatedUser,
    @Param('employeeId') employeeId: string,
  ) {
    return this.assignments.historyFor(rlsContextFor(caller), employeeId);
  }

  @Put()
  @ApiOperation({
    summary: 'Assign a location, from an effective date',
    description:
      '**Appends.** A prior assignment is never altered, so a transfer stays explicable months ' +
      'later with who decided it and when it took effect.',
  })
  async assign(
    @UserEntity() caller: AuthenticatedUser,
    @Param('employeeId') employeeId: string,
    @Body() dto: AssignLocationDto,
  ) {
    return this.assignments.assign(
      rlsContextFor(caller),
      employeeId,
      dto,
      caller.id,
    );
  }
}
