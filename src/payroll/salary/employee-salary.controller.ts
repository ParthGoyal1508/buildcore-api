import { Controller, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Request, Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { callerFrom } from '../../hr/caller-context';
import { SalaryPdfService } from './salary-pdf.service';
import { SalaryService } from './salary.service';

/**
 * An employee's payslips, as HR sees them (2026-10-14).
 *
 * The employee's own copy is under `/my/salary` and addressable only as "mine". HR needs the same
 * document for anyone on the payroll — to hand over, to check before a slip run is emailed — so
 * this is the `PAYROLL`-gated twin, rendering through the same service and the same PDF builder.
 */
@ApiTags('Payroll')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PAYROLL)
@Controller('hr/payroll/employees/:employeeId/slips')
export class EmployeeSalaryController {
  constructor(
    private readonly salary: SalaryService,
    private readonly pdf: SalaryPdfService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Periods this employee has a published payslip for, newest first',
  })
  async periods(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('employeeId') employeeId: string,
  ): Promise<string[]> {
    return this.salary.availablePeriodsForEmployee(
      callerFrom(user, request),
      employeeId,
    );
  }

  @Get(':period/pdf')
  @ApiOperation({ summary: "The employee's payslip for one period, as a PDF" })
  @ApiProduces('application/pdf')
  async slipPdf(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('employeeId') employeeId: string,
    @Param('period') period: string,
    @Res() response: Response,
  ): Promise<void> {
    const caller = callerFrom(user, request);
    const { slip, employeeName, companyId } =
      await this.salary.getSlipForEmployee(caller, employeeId, period);
    const logo = await this.salary.logoForCompany(companyId);
    const pdf = await this.pdf.render(slip, employeeName, logo);

    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="payslip-${slip.employeeCode}-${period}.pdf"`,
    );
    response.send(pdf);
  }
}
