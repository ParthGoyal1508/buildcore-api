import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SalaryAdvanceStatus } from '@prisma/client';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateSalaryAdvanceDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @ApiProperty({ maximum: 1_000_000 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  // 036 F19. A cap on what one keystroke can disburse: ten lakh is far above any salary advance
  // this business gives, and well below what a stray extra zero or two would produce.
  @Max(1_000_000, { message: 'An advance cannot exceed 10,00,000.' })
  amount: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  reason: string;

  @ApiProperty({
    example: '2026-10',
    description: 'Period the advance is recovered in, in full.',
  })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'recoveryMonth must be YYYY-MM',
  })
  recoveryMonth: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;
}

export class ListAdvancesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  employeeId?: string;

  @ApiPropertyOptional({ enum: SalaryAdvanceStatus })
  @IsOptional()
  @IsEnum(SalaryAdvanceStatus)
  status?: SalaryAdvanceStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;
}
