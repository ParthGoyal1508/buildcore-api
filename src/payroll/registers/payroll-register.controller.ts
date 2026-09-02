import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
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
import { PayrollRegisterService } from './payroll-register.service';

/**
 * The salary register and deduction report (005 amendment US16).
 *
 * Both read from a processed run — the views payroll is actually reviewed and
 * signed off from, and the ones that reconcile against the challans.
 */
@ApiTags('HR — Payroll')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PAYROLL)
@Controller('hr/payroll/runs/:runId')
export class PayrollRegisterController {
  constructor(private readonly registers: PayrollRegisterService) {}

  @Get('salary-register')
  @ApiOperation({
    summary: 'Full earnings and deductions breakup with column totals',
    description:
      'Filterable by department, project or site. When unfiltered, the totals ' +
      'are reconciled against the run’s own stored total and any difference is ' +
      'reported rather than shown as a quietly different number.',
  })
  @ApiResponse({ status: 400, description: 'That run is still a draft.' })
  async salaryRegister(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('runId') runId: string,
    @Query('departmentId') departmentId?: string,
    @Query('projectId') projectId?: string,
    @Query('siteId') siteId?: string,
  ) {
    return this.registers.salaryRegister(callerFrom(user, request), runId, {
      departmentId,
      projectId,
      siteId,
    });
  }

  @Get('deduction-report')
  @ApiOperation({
    summary: 'Each deduction head with employee count and total',
    description:
      'Split statutory / non-statutory. The statutory heads read the same line ' +
      'items the challans derive from, so the two reconcile by construction.',
  })
  async deductionReport(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('runId') runId: string,
  ) {
    return this.registers.deductionReport(callerFrom(user, request), runId);
  }

  @Get('salary-register/export')
  @ApiOperation({ summary: 'The salary register as an XLSX' })
  async exportRegister(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('runId') runId: string,
    @Res() response: Response,
    @Query('departmentId') departmentId?: string,
    @Query('projectId') projectId?: string,
    @Query('siteId') siteId?: string,
  ): Promise<void> {
    const { buffer, filename } = await this.registers.exportRegister(
      callerFrom(user, request),
      runId,
      { departmentId, projectId, siteId },
    );
    response.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );
    response.send(buffer);
  }
}
