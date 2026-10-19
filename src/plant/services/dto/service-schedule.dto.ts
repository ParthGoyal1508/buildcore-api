import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateServiceScheduleDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  equipmentId!: string;

  @ApiProperty({ example: 'Engine oil and filter' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  serviceType!: string;

  @ApiPropertyOptional({
    description:
      'For an hours-metered machine. One of intervalHours or intervalKm is required.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(1)
  @Max(999_999_999_999_999)
  intervalHours?: number;

  @ApiPropertyOptional({ description: 'For a km-metered machine' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(1)
  @Max(999_999_999_999_999)
  intervalKm?: number;

  @ApiProperty({
    description: 'Meter reading at the last service of this type',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(999_999_999_999_999)
  lastDoneReading!: number;
}

export class UpdateServiceScheduleDto extends PartialType(
  CreateServiceScheduleDto,
) {}

export class ListServiceSchedulesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  equipmentId?: string;

  @ApiPropertyOptional({ enum: ['ok', 'due_soon', 'overdue'] })
  @IsOptional()
  @IsIn(['ok', 'due_soon', 'overdue'])
  status?: 'ok' | 'due_soon' | 'overdue';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  page?: number;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  pageSize?: number;
}
