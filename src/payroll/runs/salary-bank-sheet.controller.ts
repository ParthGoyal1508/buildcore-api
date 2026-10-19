import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
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
import {
  BankSheetHistoryQueryDto,
  SalaryBankSheetQueryDto,
} from './dto/salary-bank-sheet.dto';

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

  @Get('history')
  @ApiOperation({
    summary: 'Bank sheets generated for a company, newest first',
    description:
      'Every download, from here and from a run, with who generated it, the debit account, the ' +
      'count and the total. Filter to one month with `year` and `month`.',
  })
  async history(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query() query: BankSheetHistoryQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { rows, total } = await this.bankSheet.historyPage(
      callerFrom(user, request),
      resolveCompanyId(user, query.companyId),
      query.year && query.month
        ? periodOf(query as SalaryBankSheetQueryDto)
        : undefined,
      { page: query.page, pageSize: query.pageSize },
    );
    // 036 F11. The body stays the array it always was; the count rides in a header so paging is
    // additive for the current screen.
    response.setHeader('X-Total-Count', String(total));
    return rows;
  }

  @Get('history/:id/file')
  @ApiOperation({ summary: 'The exact file a history entry gave the bank' })
  async historyFile(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
    @Res() response: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.bankSheet.historyFile(
      callerFrom(user, request),
      id,
    );
    response.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader('Content-Disposition', contentDispositionFor(filename));
    response.setHeader('Cache-Control', 'no-store');
    response.send(buffer);
  }

  /**
   * 036 F11. Generating the sheet is a write — it records advance recoveries against the transfer
   * and a history entry — so it is a `POST`. Same parameters as the `GET`, in the body.
   */
  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Generate Salary_Bank_Sheet_<Company>_<Month>_<Year>.xlsx (records recoveries and history)',
  })
  async generate(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Body() body: SalaryBankSheetQueryDto,
    @Res() response: Response,
  ): Promise<void> {
    return this.sendSheet(user, request, body, response);
  }

  // The deprecated mutating `GET` (036 F11) was removed in Wave 3, stream 3b, once the web app
  // posted. It still generated — writing recoveries and a history entry — on a verb that promises
  // to change nothing. Re-download a past file from `history/:id/file`.

  private async sendSheet(
    user: AuthenticatedUser,
    request: Request,
    query: SalaryBankSheetQueryDto,
    response: Response,
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
