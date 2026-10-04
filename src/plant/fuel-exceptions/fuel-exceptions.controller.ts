import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { FuelExceptionStatus, Permission } from '@prisma/client';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { ReviewFuelExceptionDto } from './dto/fuel-exception.dto';
import { FuelExceptionsService } from './fuel-exceptions.service';

/**
 * Reviewing fuel burned beyond benchmark (020 FR-001, FR-002, FR-008, FR-009) — item 13.
 *
 * `MACHINERY`, the same permission as the fuel entries these review. Under 019's level model the
 * list needs read and the review needs write, derived from the verb — right here, since a
 * confirmation is what a recovery is later raised against.
 */
@ApiTags('Plant — Fuel exceptions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.MACHINERY)
@Controller('plant/fuel/exceptions')
export class FuelExceptionsController {
  constructor(private readonly exceptions: FuelExceptionsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Machines that burned more fuel than their benchmark, and what was decided',
    description:
      'Each exception with its reading, its machine and the category benchmark it breached ' +
      '(FR-001). Detection itself is untouched by this module (FR-017).',
  })
  async list(
    @UserEntity() caller: AuthenticatedUser,
    @Query('status') status?: FuelExceptionStatus,
  ) {
    return this.exceptions.list(caller, status);
  }

  @Post('raise')
  @ApiOperation({
    summary: 'Raise an exception for every alerted reading that has none',
    description:
      'Idempotent: the unique index on `fuelEntryId` means running it twice raises nothing the ' +
      'second time. A sweep rather than a hook inside the detector, so detection and review ' +
      'cannot silently alter one another (FR-017).',
  })
  async raise(@UserEntity() caller: AuthenticatedUser) {
    const raised = await this.exceptions.raiseOutstanding(caller);
    return { raised };
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Confirm with an attribution, or dismiss with a reason',
    description:
      'Refuses a confirmation that names nobody (FR-002), a dismissal with no reason (FR-008), ' +
      'a hirer attribution on an owned machine (FR-004), and an operator attribution that does ' +
      'not name one where several ran the machine (FR-009). **Moves no money** — recovery is a ' +
      'separate act with its own approval.',
  })
  async review(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReviewFuelExceptionDto,
    @Req() request: { ip?: string },
  ) {
    return this.exceptions.review(caller, id, dto, request.ip ?? 'unknown');
  }
}
