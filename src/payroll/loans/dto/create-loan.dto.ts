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
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateLoanDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @ApiProperty({
    description: 'Principal advanced to the employee.',
    maximum: 10_000_000,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  // 036 F19. One crore: above any employee loan this business makes, below a typo's reach.
  @Max(10_000_000, { message: 'A loan cannot exceed 1,00,00,000.' })
  amount: number;

  @ApiProperty({
    description: 'Monthly instalment recovered through payroll.',
    maximum: 10_000_000,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(10_000_000, { message: 'An EMI cannot exceed 1,00,00,000.' })
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
