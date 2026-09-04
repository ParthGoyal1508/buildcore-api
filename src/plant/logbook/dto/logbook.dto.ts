import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateLogbookEntryDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  equipmentId!: string;

  @ApiProperty({ example: '2026-09-04' })
  @IsISO8601()
  date!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  openingReading!: number;

  @ApiProperty({
    description:
      'Must be at least the opening reading. Equal is legitimate — a machine that ' +
      'stood idle all day still gets an entry, with zero hours.',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  closingReading!: number;

  @ApiPropertyOptional({
    description: 'Litres burned, as the operator recorded them',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  fuelConsumed?: number;

  @ApiPropertyOptional({ description: 'The operating employee' })
  @IsOptional()
  @IsString()
  operatorId?: string;

  @ApiPropertyOptional({
    description:
      'The project the machine worked that day. Recorded per entry rather than ' +
      'inferred from the deployed site, because a machine can work a project that ' +
      "is not its site's.",
  })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}

/**
 * Readings are absent by design: they are what `currentReading`, utilisation and
 * every hire bill's logbook snapshot are computed from, and editing them after the
 * fact would silently restate all three. Correct a wrong reading by deleting the
 * entry and re-recording it.
 */
export class UpdateLogbookEntryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  fuelConsumed?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  operatorId?: string;
}

export class ListLogbookDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  equipmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsOptional()
  @IsISO8601()
  dateTo?: string;

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
