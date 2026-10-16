import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { LeaveCreditMode, Permission } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import * as ExcelJS from 'exceljs';
import type { Request, Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { contentDispositionFor } from '../../common/storage/file-type';
import { resolveCompanyId } from '../../settings/company-scope';
import { callerFrom } from '../caller-context';
import {
  CREDITED_LEAVE_TYPES,
  type CreditedLeaveType,
  LeaveCreditService,
} from './leave-credit.service';
import { financialYearOf } from './leave-days';

const FY = /^\d{4}-\d{2}$/;

export class LeavePolicyRowDto {
  @ApiProperty({ enum: CREDITED_LEAVE_TYPES })
  @IsIn(CREDITED_LEAVE_TYPES)
  leaveType!: CreditedLeaveType;

  @ApiProperty({ example: 18 })
  @IsNumber()
  @Min(0)
  @Max(365)
  annualDays!: number;

  @ApiProperty({ enum: LeaveCreditMode })
  @IsIn(Object.values(LeaveCreditMode))
  creditMode!: LeaveCreditMode;

  @ApiProperty() @IsBoolean() carryForward!: boolean;

  @ApiProperty({ nullable: true, example: 45 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  carryForwardCap!: number | null;

  @ApiProperty() @IsBoolean() prorateJoiners!: boolean;
}

export class SetLeavePolicyDto {
  @ApiProperty({ type: [LeavePolicyRowDto] })
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => LeavePolicyRowDto)
  rows!: LeavePolicyRowDto[];
}

export class LeaveAdjustmentDto {
  @ApiProperty() @IsString() @IsNotEmpty() employeeId!: string;

  @ApiProperty({ enum: CREDITED_LEAVE_TYPES })
  @IsIn(CREDITED_LEAVE_TYPES)
  leaveType!: CreditedLeaveType;

  @ApiProperty({ example: '2026-27' })
  @Matches(FY, { message: 'financialYear must be YYYY-YY' })
  financialYear!: string;

  /** Signed: negative takes days away. */
  @ApiProperty({ example: 2 })
  @IsNumber()
  @Min(-365)
  @Max(365)
  days!: number;

  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(500) reason!: string;
}

export class OpeningImportDto {
  @ApiProperty({ example: '2026-27' })
  @Matches(FY, { message: 'financialYear must be YYYY-YY' })
  financialYear!: string;

  /** The filled-in template, base64. */
  @ApiProperty() @IsString() @IsNotEmpty() file!: string;
}

/**
 * HR's leave entitlement controls (2026-10-16): the policy, crediting on demand, one-off
 * adjustments, the go-live opening-balance import, and each employee's history. ATTENDANCE, like
 * the rest of HR's leave screens.
 */
@ApiTags('HR — Leave')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.ATTENDANCE)
@Controller('hr/leave')
export class LeaveCreditController {
  constructor(private readonly credits: LeaveCreditService) {}

  @Get('policy')
  @ApiOperation({
    summary:
      "The company's leave policy — the built-in defaults until HR saves its own",
  })
  async policy(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query('companyId') companyId?: string,
  ) {
    const caller = callerFrom(user, request);
    return this.credits.getPolicy(
      caller.rls,
      resolveCompanyId(user, companyId),
    );
  }

  @Put('policy')
  @ApiOperation({ summary: "Save the company's leave policy" })
  async setPolicy(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Body() dto: SetLeavePolicyDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.credits.setPolicy(
      callerFrom(user, request),
      resolveCompanyId(user, companyId),
      dto.rows,
    );
  }

  @Post('credits/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Credit everything due so far this year (safe to repeat)',
    description:
      'The daily job does this on its own; the button is for straight after a policy change.',
  })
  async run(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query('companyId') companyId?: string,
  ) {
    const caller = callerFrom(user, request);
    return this.credits.runCredits(
      caller.rls,
      resolveCompanyId(user, companyId),
    );
  }

  @Post('adjustments')
  @ApiOperation({
    summary: 'Add or take away days for one employee, with a reason',
  })
  async adjust(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Body() dto: LeaveAdjustmentDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.credits.adjust(
      callerFrom(user, request),
      resolveCompanyId(user, companyId),
      dto,
    );
  }

  @Get('ledger')
  @ApiOperation({
    summary: "Where one employee's balances came from, for a financial year",
  })
  async ledger(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Query('employeeId') employeeId: string,
    @Query('financialYear') financialYear?: string,
    @Query('companyId') companyId?: string,
  ) {
    if (!employeeId) throw new BadRequestException('employeeId is required');
    const caller = callerFrom(user, request);
    return this.credits.ledger(
      caller.rls,
      resolveCompanyId(user, companyId),
      employeeId,
      financialYear ??
        financialYearOf(new Date(`${this.credits.today()}T00:00:00Z`)),
    );
  }

  @Get('opening-balances/template.xlsx')
  @ApiOperation({
    summary:
      'The opening-balance sheet: every active employee, with their current opening',
  })
  async template(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Res() res: Response,
    @Query('financialYear') financialYear?: string,
    @Query('companyId') companyId?: string,
  ) {
    const caller = callerFrom(user, request);
    const fy =
      financialYear ??
      financialYearOf(new Date(`${this.credits.today()}T00:00:00Z`));
    const rows = await this.credits.templateRows(
      caller.rls,
      resolveCompanyId(user, companyId),
      fy,
    );
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet(`Opening ${fy}`);
    sheet.columns = [
      { header: 'Employee Code', key: 'employeeCode', width: 16 },
      { header: 'Name', key: 'name', width: 28 },
      { header: 'Earned', key: 'earned', width: 10 },
      { header: 'Casual', key: 'casual', width: 10 },
      { header: 'Sick', key: 'sick', width: 10 },
    ];
    sheet.getRow(1).font = { bold: true };
    rows.forEach((row) => sheet.addRow(row));
    const buffer = Buffer.from(await book.xlsx.writeBuffer());
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      contentDispositionFor(`Leave opening balances ${fy}.xlsx`),
    );
    res.send(buffer);
  }

  @Post('opening-balances')
  @ApiOperation({
    summary:
      'Import opening balances from the filled-in template (sets, does not add)',
  })
  async importOpening(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Body() dto: OpeningImportDto,
    @Query('companyId') companyId?: string,
  ) {
    const book = new ExcelJS.Workbook();
    try {
      await book.xlsx.load(
        Buffer.from(
          dto.file.replace(/^data:[^,]*,/, ''),
          'base64',
        ) as unknown as ArrayBuffer,
      );
    } catch {
      throw new BadRequestException('That file is not an Excel workbook.');
    }
    const sheet = book.worksheets[0];
    if (!sheet) throw new BadRequestException('The workbook has no sheet.');

    // Columns found by header, so a sheet with them reordered still imports.
    const header = sheet.getRow(1);
    const col: Record<string, number> = {};
    header.eachCell((cell, index) => {
      col[
        String(cell.value ?? '')
          .trim()
          .toLowerCase()
      ] = index;
    });
    if (!col['employee code']) {
      throw new BadRequestException(
        'The sheet needs an "Employee Code" column.',
      );
    }
    const rows: {
      employeeCode: string;
      leaveType: CreditedLeaveType;
      opening: number;
    }[] = [];
    sheet.eachRow((row, index) => {
      if (index === 1) return;
      const code = String(row.getCell(col['employee code']).value ?? '').trim();
      if (!code) return;
      for (const leaveType of CREDITED_LEAVE_TYPES) {
        const at = col[leaveType];
        if (!at) continue;
        const raw = row.getCell(at).value;
        if (raw === null || raw === undefined || raw === '') continue;
        const opening = Number(raw);
        if (Number.isFinite(opening))
          rows.push({ employeeCode: code, leaveType, opening });
      }
    });
    if (rows.length === 0) {
      throw new BadRequestException('No balances were found in the sheet.');
    }
    return this.credits.importOpening(
      callerFrom(user, request),
      resolveCompanyId(user, companyId),
      dto.financialYear,
      rows,
    );
  }
}
