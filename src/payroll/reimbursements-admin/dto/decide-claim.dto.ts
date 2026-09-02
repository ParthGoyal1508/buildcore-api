import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ReimbursementClaimStatus,
  ReimbursementPaymentMode,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class ApproveClaimDto {
  @ApiPropertyOptional({ description: 'Optional note recorded with the approval.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}

export class RejectClaimDto {
  @ApiProperty({
    description:
      'Required. A rejection with no reason gives the employee nothing to act ' +
      'on and no basis to dispute (FR-037).',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  remarks: string;
}

export class PayClaimDto {
  @ApiProperty({
    enum: ReimbursementPaymentMode,
    description:
      '`direct` settles outside payroll and needs a reference; `payroll` adds ' +
      'the amount to the employee’s next run instead.',
  })
  @IsEnum(ReimbursementPaymentMode)
  paymentMode: ReimbursementPaymentMode;

  @ApiPropertyOptional({
    description: 'Required for a direct payment — the transfer reference.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  paymentReference?: string;
}

export class ListClaimsQueryDto {
  @ApiPropertyOptional({ enum: ReimbursementClaimStatus })
  @IsOptional()
  @IsEnum(ReimbursementClaimStatus)
  status?: ReimbursementClaimStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  employeeId?: string;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to?: string;

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
