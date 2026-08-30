import { Controller, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { UserEntity } from '../../common/decorators/user.decorator';
import { callerFrom } from '../../hr/caller-context';
import { SalaryPdfService } from './salary-pdf.service';
import { SalaryService } from './salary.service';

/**
 * The employee's own payslips (US5).
 *
 * Under `/my/*` and resolved from the token like every other route in that tree —
 * a payslip is among the most sensitive things this API serves, and it is
 * addressable only as "mine" (FR-028).
 */
@ApiTags('My Workspace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('my/salary')
export class SalaryController {
  constructor(
    private readonly salary: SalaryService,
    private readonly pdf: SalaryPdfService,
  ) {}

  @Get('available-periods')
  @ApiOperation({ summary: 'Periods the caller has a published payslip for' })
  @ApiResponse({
    status: 200,
    description:
      'Newest first. Excludes periods whose payroll run is still draft (FR-024).',
  })
  async availablePeriods(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<string[]> {
    return this.salary.getAvailablePeriods(callerFrom(user, request));
  }

  @Get(':period')
  @ApiOperation({ summary: "The caller's payslip for one period" })
  @ApiResponse({
    status: 404,
    description: 'No published payslip exists for that period.',
  })
  async slip(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('period') period: string,
  ) {
    return this.salary.getSlip(callerFrom(user, request), period);
  }

  @Get(':period/pdf')
  @ApiOperation({ summary: 'The same payslip as a PDF' })
  @ApiProduces('application/pdf')
  async slipPdf(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('period') period: string,
    @Res() response: Response,
  ): Promise<void> {
    // Rendered from the value `getSlip` returns, not from a second query, so the
    // PDF can never show different figures from the JSON (research.md §7).
    const slip = await this.salary.getSlip(callerFrom(user, request), period);
    const pdf = await this.pdf.render(
      slip,
      `${user.firstname ?? ''} ${user.lastname ?? ''}`.trim(),
    );

    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="payslip-${slip.employeeCode}-${period}.pdf"`,
    );
    response.send(pdf);
  }
}
