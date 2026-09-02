import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PayrollRunStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Matches } from 'class-validator';

export class GeneratePayrollDto {
  @ApiProperty({ example: '2026-08', description: 'Period key, YYYY-MM.' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period must be YYYY-MM' })
  period: string;

  @ApiPropertyOptional({
    description: 'Required only for a cross-company caller.',
  })
  @IsOptional()
  @IsString()
  companyId?: string;
}

export class SetRunStatusDto {
  @ApiProperty({
    enum: [PayrollRunStatus.processed, PayrollRunStatus.paid],
    description:
      'Draft → processed freezes the figures; processed → paid records ' +
      'disbursement. Neither is reversible.',
  })
  @IsEnum(PayrollRunStatus)
  status: PayrollRunStatus;
}
