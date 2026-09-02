import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SalaryAdvanceStatus } from '@prisma/client';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateSalaryAdvanceDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @ApiProperty()
  @IsNumber()
  @Min(1)
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
