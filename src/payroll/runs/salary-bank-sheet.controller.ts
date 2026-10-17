import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Request, Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { contentDispositionFor } from '../../common/storage/file-type';
import { callerFrom } from '../../hr/caller-context';
import { resolveCompanyId } from '../../settings/company-scope';
import { BankSheetService } from './bank-sheet.service';
import { SalaryBankSheetQueryDto } from './dto/salary-bank-sheet.dto';

/**
 * The salary bank payment sheet by company and month (2026-10-17), for HR and accounts: the same
 * file as a run's own bank sheet, reached without opening the run, with a preview that lists who
 * is left off and why before anything is downloaded or recovered.
 *
 * `PAYROLL`, like the run surface: the file carries unmasked account numbers.
 */
@ApiTags('Payroll')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PAYROLL)
@Controller('hr/payroll/bank-sheet')
export class SalaryBankSheetController {
  constructor(private readonly bankSheet: BankSheetService) {}

  @Get('preview')
  @ApiOperation({
    summary: 'Count, total and everyone left off, before download',
    description:
      'Only finalised payroll, only net pay above zero. Missing or invalid bank details ' +
      '(account number, IFSC, account holder name) are listed so they can be fixed or ' +
      'excluded. `reconciles` says whether the sheet plus everything left off equals the ' +
      "payroll's net pay.",
  })
  async preview(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query() query: SalaryBankSheetQueryDto,
  ) {
    const caller = callerFrom(user, request);
    const run = await this.bankSheet.findRegularRun(
      caller,
      resolveCompanyId(user, query.companyId),
      periodOf(query),
    );
    return this.bankSheet.preview(caller, run.id, optionsOf(query));
  }

  @Get()
  @ApiOperation({
    summary:
      'Salary_Bank_Sheet_<Company>_<Month>_<Year>.xlsx in the bank format',
  })
  async download(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query() query: SalaryBankSheetQueryDto,
    @Res() response: Response,
  ): Promise<void> {
    const caller = callerFrom(user, request);
    const run = await this.bankSheet.findRegularRun(
      caller,
      resolveCompanyId(user, query.companyId),
      periodOf(query),
    );
    const { buffer, filename } = await this.bankSheet.build(caller, run.id, {
      ...optionsOf(query),
      companyNamedFile: true,
    });
    response.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader('Content-Disposition', contentDispositionFor(filename));
    response.setHeader('Cache-Control', 'no-store');
    response.send(buffer);
  }
}

function periodOf(query: SalaryBankSheetQueryDto): string {
  return `${query.year}-${String(query.month).padStart(2, '0')}`;
}

function optionsOf(query: SalaryBankSheetQueryDto) {
  return {
    debitAccount: query.debitAccount,
    excludeEmployeeIds: (query.exclude ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  };
}
