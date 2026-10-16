import {
  Body,
  ConflictException,
  Controller,
  Get,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TaxDeclarationStatus } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SelfService } from '../common/decorators/route-access.decorator';
import { UserEntity } from '../common/decorators/user.decorator';
import { callerFrom } from '../hr/caller-context';
import { EmployeesService } from '../hr/employees/employees.service';
import { SalaryAdvancesService } from './advances/salary-advances.service';
import { LoansService } from './loans/loans.service';
import { DeclareTaxDto, FinancialYearQueryDto } from './tds/dto/tds.dto';
import { TdsService } from './tds/tds.service';

/**
 * An employee's own loans, salary advances and tax declaration (2026-10-16, My Workspace).
 *
 * The admin screens behind these need LOANS or PAYROLL and show everybody; this shows the caller
 * their own and nothing else. Like every `/my/*` controller, no route takes an employee id — the
 * employee is resolved from the token, so there is no parameter through which to read another's.
 */
@ApiTags('My Workspace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@SelfService()
@Controller('my')
export class MyPayrollController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly loans: LoansService,
    private readonly advances: SalaryAdvancesService,
    private readonly tds: TdsService,
  ) {}

  private async me(user: AuthenticatedUser, request: Request) {
    const caller = callerFrom(user, request);
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );
    return { caller, employee };
  }

  @Get('loans')
  @ApiOperation({
    summary: "The caller's own loans, each with its EMI schedule",
  })
  async loansMine(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const { caller, employee } = await this.me(user, request);
    const page = await this.loans.list(caller, employee.companyId, {
      employeeId: employee.id,
      pageSize: 100,
    });
    return page.items;
  }

  @Get('salary-advances')
  @ApiOperation({ summary: "The caller's own salary advances" })
  async advancesMine(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const { caller, employee } = await this.me(user, request);
    return this.advances.list(caller, employee.companyId, {
      employeeId: employee.id,
    });
  }

  @Get('tds/declaration')
  @ApiOperation({
    summary:
      "The caller's investment declaration for a financial year, or null",
  })
  async declaration(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query() query: FinancialYearQueryDto,
  ) {
    const { caller, employee } = await this.me(user, request);
    return this.tds.getDeclaration(caller, employee.id, query.financialYear);
  }

  @Put('tds/declaration')
  @ApiOperation({
    summary: "Submit or revise the caller's investment declaration",
    description:
      'Each line is capped at its section ceiling. Refused once payroll has verified any line ' +
      'against proof: a revision would replace the verified lines, so further changes go ' +
      'through payroll.',
  })
  async declare(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Body() dto: DeclareTaxDto,
  ) {
    const { caller, employee } = await this.me(user, request);
    const existing = await this.tds.getDeclaration(
      caller,
      employee.id,
      dto.financialYear,
    );
    const verified = (existing?.lines ?? []).some(
      (line: { status?: string }) =>
        line.status === TaxDeclarationStatus.verified,
    );
    if (verified) {
      throw new ConflictException({
        code: 'DECLARATION_VERIFIED',
        message:
          'Payroll has already verified part of this declaration, so it can no longer be changed here. Ask payroll to revise it.',
      });
    }
    return this.tds.declare(
      caller,
      employee.id,
      dto.financialYear,
      dto.regime,
      dto.lines,
    );
  }
}
