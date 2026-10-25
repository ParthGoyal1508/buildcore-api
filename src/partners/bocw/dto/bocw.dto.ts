import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
} from 'class-validator';

/** The derived per-project cess states a row can be in. */
export const BOCW_STATUSES = ['pending', 'partial', 'paid'] as const;

export class ListBocwQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;

  @ApiPropertyOptional({
    description:
      'Rows whose project name contains this, case-insensitive (042).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({
    enum: BOCW_STATUSES,
    description: 'Rows in this payment state only (042).',
  })
  @IsOptional()
  @IsIn(BOCW_STATUSES)
  status?: (typeof BOCW_STATUSES)[number];
}

export class CreateBocwPaymentDto {
  @ApiProperty({ description: 'Must be greater than zero' })
  @IsNumber()
  @IsPositive()
  @Max(999_999_999_999.99)
  amountPaid: number;

  @ApiProperty({ description: 'ISO date' })
  @IsDateString()
  paymentDate: string;

  @ApiProperty({ description: 'Challan or transfer reference' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  referenceNumber: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}
