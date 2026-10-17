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
