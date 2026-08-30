import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

/** Wall-clock time of day, `HH:mm` (24-hour). Stored as a Postgres `time`. */
const TIME_OF_DAY = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export class CreateShiftDto {
  /** Only meaningful for a cross-company caller (see DocumentTypesService). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;

  @ApiProperty({ description: 'Unique per company' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: '09:00' })
  @Matches(TIME_OF_DAY, { message: 'inTime must be HH:mm' })
  inTime: string;

  @ApiProperty({ example: '18:00' })
  @Matches(TIME_OF_DAY, { message: 'outTime must be HH:mm' })
  outTime: string;

  @ApiPropertyOptional({ description: 'Late-arrival tolerance, in minutes' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  graceMinutes?: number;
}

export class UpdateShiftDto extends PartialType(CreateShiftDto) {}
