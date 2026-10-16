import {
  Body,
  Controller,
  Get,
  Ip,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { ResignationReasonCategory } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';
import type { Request } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { SelfService } from '../../common/decorators/route-access.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { callerFrom } from '../../hr/caller-context';
import { EmployeesService } from '../../hr/employees/employees.service';
import { WithdrawResignationDto } from './dto/resignation.dto';
import { ResignationService } from './resignation.service';

/** The default notice an employee's own resignation starts from; HR settles the real one. */
const SELF_NOTICE_DAYS = 30;

export class SubmitMyResignationDto {
  @ApiProperty({ example: '2026-11-01' })
  @IsDateString()
  resignationDate!: string;

  @ApiProperty({ enum: ResignationReasonCategory })
  @IsEnum(ResignationReasonCategory)
  reasonCategory!: ResignationReasonCategory;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reasonDetail!: string;
}

/**
 * An employee resigning, and following it, from My Workspace (2026-10-16).
 *
 * Until now a resignation could only be recorded by Recruitment on the employee's behalf. The
 * record is the same one Recruitment lists and accepts — so HR sees it at once and settles the
 * last working day on acceptance. The notice period starts at a standard 30 days; acceptance can
 * agree a different day or waive notice.
 */
@ApiTags('My Workspace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@SelfService()
@Controller('my/resignation')
export class MyResignationController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly resignations: ResignationService,
  ) {}

  private async employeeOf(user: AuthenticatedUser, request: Request) {
    const caller = callerFrom(user, request);
    return this.employees.requireByUserId(caller.rls, caller.userId);
  }

  @Get()
  @ApiOperation({ summary: "The caller's own resignations, newest first" })
  async mine(@UserEntity() user: AuthenticatedUser, @Req() request: Request) {
    const employee = await this.employeeOf(user, request);
    return this.resignations.findAll(user, { employeeId: employee.id });
  }

  @Post()
  @ApiOperation({ summary: 'Submit a resignation' })
  async submit(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Body() dto: SubmitMyResignationDto,
    @Ip() ip: string,
  ) {
    const employee = await this.employeeOf(user, request);
    return this.resignations.create(
      user,
      {
        employeeId: employee.id,
        resignationDate: dto.resignationDate,
        reasonCategory: dto.reasonCategory,
        reasonDetail: dto.reasonDetail,
        noticePeriodDays: SELF_NOTICE_DAYS,
      },
      ip,
    );
  }

  @Post(':id/withdraw')
  @ApiOperation({ summary: 'Withdraw the caller’s own resignation' })
  async withdraw(
    @UserEntity() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: WithdrawResignationDto,
    @Ip() ip: string,
  ) {
    const employee = await this.employeeOf(user, request);
    const own = await this.resignations.findAll(user, {
      employeeId: employee.id,
    });
    if (!own.some((r) => r.id === id)) {
      throw new NotFoundException('Resignation not found');
    }
    return this.resignations.withdraw(user, id, dto.reason, ip);
  }
}
