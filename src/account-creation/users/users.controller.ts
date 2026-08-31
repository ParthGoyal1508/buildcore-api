import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Request } from 'express';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { rlsContextFor } from '../../common/prisma/rls-context';
import { EmployeesService } from '../../hr/employees/employees.service';
import { CreateUserDto } from './dto/create-user.dto';
import { AdminCaller, UsersService } from './users.service';

function callerFrom(user: AuthenticatedUser, request: Request): AdminCaller {
  return {
    userId: user.id,
    companyId: user.companyId,
    ipAddress: request.ip ?? request.socket?.remoteAddress ?? 'unknown',
    rls: rlsContextFor(user),
  };
}

/**
 * Account creation and invite management.
 *
 * Deliberately no GET/PATCH/DELETE for accounts here — that surface belongs to
 * 002's `/settings/users`, which calls this feature's exported `UsersService`
 * methods (research.md §8). Two controllers over one resource would be two places
 * to keep a permission check correct.
 */
@ApiTags('Account Creation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.USER_MANAGEMENT)
@Controller('account-creation')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly employees: EmployeesService,
  ) {}

  @Post('users')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a pending account and email its invite' })
  async create(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Body() dto: CreateUserDto,
  ) {
    return this.users.create(callerFrom(user, request), dto);
  }

  @Post('users/:id/resend-invite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Issue a fresh invite for a pending account' })
  async resendInvite(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
  ) {
    return this.users.resendInvite(callerFrom(user, request), id);
  }

  @Get('employees/unlinked')
  @ApiOperation({
    summary: 'Employees with no account yet, for the invite form picker',
  })
  async unlinkedEmployees(
    @UserEntity() user: AuthenticatedUser,
    @Query('companyId') companyId: string,
    @Query('search') search?: string,
  ) {
    const caller = rlsContextFor(user);
    // Falls back to the caller's own company: a non-cross-company admin has no
    // business naming a different one, and RLS would reject it anyway.
    return this.employees.getUnlinkedEmployees(
      caller,
      companyId ?? user.companyId,
      search,
    );
  }
}
