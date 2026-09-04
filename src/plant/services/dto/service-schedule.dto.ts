import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateServiceScheduleDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
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
  intervalHours?: number;

  @ApiPropertyOptional({ description: 'For a km-metered machine' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(1)
  intervalKm?: number;

  @ApiProperty({
    description: 'Meter reading at the last service of this type',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  lastDoneReading!: number;
}

export class UpdateServiceScheduleDto extends PartialType(
  CreateServiceScheduleDto,
) {}

export class ListServiceSchedulesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  equipmentId?: string;

  @ApiPropertyOptional({ enum: ['ok', 'due_soon', 'overdue'] })
  @IsOptional()
  @IsIn(['ok', 'due_soon', 'overdue'])
  status?: 'ok' | 'due_soon' | 'overdue';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}
