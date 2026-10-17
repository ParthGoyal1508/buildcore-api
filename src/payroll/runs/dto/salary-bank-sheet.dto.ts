import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class SalaryBankSheetQueryDto {
  @ApiPropertyOptional({
    description: 'Required for a cross-company caller; ignored otherwise',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;

  @ApiProperty({ example: 2026 })
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2999)
  year!: number;

  @ApiProperty({ example: 9 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @ApiPropertyOptional({
    description: "Overrides the company's payroll debit account for this sheet",
  })
  @IsOptional()
  @Matches(/^\d{6,20}$/, {
    message: 'The debit account number should be 6 to 20 digits.',
  })
  debitAccount?: string;

  @ApiPropertyOptional({
    description: 'Comma-separated employee ids to leave off this sheet',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  exclude?: string;
}

/** The generated-sheet history: a company's, optionally for one month (2026-10-17). */
export class BankSheetHistoryQueryDto {
  @ApiPropertyOptional({
    description: 'Required for a cross-company caller; ignored otherwise',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;

  @ApiPropertyOptional({ example: 2026 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2999)
  year?: number;

  @ApiPropertyOptional({ example: 9 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;

  /**
   * 036 F11. Paging for the history, which used to stop silently at 100. The response is still the
   * plain array it always was; the total comes back in `X-Total-Count`. Defaults keep the old
   * behaviour for a caller that sends neither.
   */
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 100, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}
