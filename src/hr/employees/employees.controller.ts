import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
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
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { callerFrom } from '../caller-context';
import {
  CreateEmployeeDto,
  ListEmployeesQueryDto,
  RevealPiiDto,
} from './dto/create-employee.dto';
import { TransferEmployeeDto } from './dto/transfer-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { EmployeesService, MaskedEmployee } from './employees.service';
import {
  PiiMaskingInterceptor,
  RevealsPii,
} from './pii-masking.interceptor';

/**
 * The HR admin employee master (005 US1).
 *
 * Distinct from `/my/*`, which resolves the employee from the caller's own token.
 * These routes take an employee id and are therefore gated on the `EMPLOYEES`
 * permission, with RLS keeping the id resolvable only within the caller's company.
 *
 * `PiiMaskingInterceptor` is applied at the controller level rather than per-route,
 * so a route added later inherits masking by default and has to opt out explicitly
 * via `@RevealsPii()` — the safe direction for that mistake.
 */
@ApiTags('HR — Employees')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.EMPLOYEES)
@UseInterceptors(PiiMaskingInterceptor)
@Controller('hr/employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  /**
   * The company an admin acts within.
   *
   * Taken from the authenticated token, never from a request parameter — the same
   * rule `/my/*` follows. A Super Admin has no single company of their own, so they
   * must name one explicitly rather than having one guessed for them.
   */
  private companyOf(user: AuthenticatedUser, queryCompanyId?: string): string {
    const companyId = user.companyId ?? queryCompanyId;
    if (!companyId) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }
    return companyId;
  }

  @Get()
  @ApiOperation({
    summary: 'Paginated employee list',
    description:
      'Filterable by search (code/first/last name), department, site and active ' +
      'status. Active-only unless `isActive=false` is passed. PII is masked.',
  })
  async list(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query() query: ListEmployeesQueryDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.employees.list(
      callerFrom(user, request),
      this.companyOf(user, companyId),
      query,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'One employee, PII masked' })
  @ApiResponse({ status: 404, description: 'No such employee in this company.' })
  async findOne(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
  ): Promise<MaskedEmployee> {
    return this.employees.getMasked(callerFrom(user, request), id);
  }

  @Post()
  @ApiOperation({
    summary: 'Create an employee',
    description:
      'The employee code is allocated from the company series — it is never ' +
      'accepted from the client.',
  })
  @ApiResponse({
    status: 400,
    description:
      'Statutory tab inconsistent — PF or ESIC marked applicable without its ' +
      'identifying number.',
  })
  async create(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Body() dto: CreateEmployeeDto,
    @Query('companyId') companyId?: string,
  ): Promise<MaskedEmployee> {
    return this.employees.create(
      callerFrom(user, request),
      this.companyOf(user, companyId),
      dto,
    );
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update an employee',
    description:
      'Company is deliberately not editable here — moving an employee between ' +
      'companies is the transfer flow, which reallocates the code and writes an ' +
      'audit record.',
  })
  async update(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: UpdateEmployeeDto,
  ): Promise<MaskedEmployee> {
    return this.employees.update(callerFrom(user, request), id, dto);
  }

  @Post(':id/transfer')
  @ApiOperation({
    summary: 'Transfer an employee to another company',
    description:
      'Allocates a new code from the destination company’s series unless ' +
      'retention is requested. Pre-transfer attendance and leave stay visible to ' +
      'the company the employee actually worked for.',
  })
  @ApiResponse({
    status: 409,
    description: 'Employee is already in the destination company.',
  })
  async transfer(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: TransferEmployeeDto,
  ) {
    return this.employees.transfer(callerFrom(user, request), id, dto);
  }

  /**
   * The one route permitted to return an unmasked value, and the only one marked
   * `@RevealsPii()`. Every call is written to the audit log before the value is
   * returned.
   */
  @Post(':id/reveal-pii')
  @RevealsPii()
  @ApiOperation({
    summary: 'Reveal one PII field, and record who looked',
    description:
      'One field per call, so the audit trail can distinguish a clerk checking a ' +
      'bank account from bulk harvesting of identity documents.',
  })
  async revealPii(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: RevealPiiDto,
  ): Promise<{ field: string; value: string | null }> {
    return this.employees.revealPii(callerFrom(user, request), id, dto);
  }
}
