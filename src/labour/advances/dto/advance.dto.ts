import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AdvanceStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import {
  MAX_ADVANCE_AMOUNT,
  MAX_RECOVERY_INSTALMENTS,
} from '../../constants/labour.constants';

export class ListAdvancesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  workerId?: string;

  @ApiPropertyOptional({ enum: AdvanceStatus })
  @IsOptional()
  @IsEnum(AdvanceStatus)
  status?: AdvanceStatus;
}

export class CreateAdvanceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  workerId!: string;

  @ApiProperty({ example: 3000 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_ADVANCE_AMOUNT)
  amount!: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;

  @ApiProperty({ example: 3 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_RECOVERY_INSTALMENTS)
  recoveryInstalments!: number;

  @ApiProperty({ example: '2026-09-01' })
  @IsDateString()
  recoveryStartPeriod!: string;
}
