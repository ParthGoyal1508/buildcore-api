import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LoanStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateLoanDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @ApiProperty({ description: 'Principal advanced to the employee.' })
  @IsNumber()
  @Min(1)
  amount: number;

  @ApiProperty({ description: 'Monthly instalment recovered through payroll.' })
  @IsNumber()
  @Min(1)
  emiAmount: number;

  @ApiProperty({ example: '2026-09-15' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'disbursementDate must be YYYY-MM-DD',
  })
  disbursementDate: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  reason: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;

  @ApiPropertyOptional({
    example: '2026-10',
    description:
      'Period the first instalment is recovered in. Defaults to the month after ' +
      'disbursement — recovering in the same month would take back part of the ' +
      'advance before the employee has had it.',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'firstRecoveryPeriod must be YYYY-MM',
  })
  firstRecoveryPeriod?: string;
}

export class ListLoansQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  employeeId?: string;

  @ApiPropertyOptional({ enum: LoanStatus })
  @IsOptional()
  @IsEnum(LoanStatus)
  status?: LoanStatus;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  pageSize?: number;
}
