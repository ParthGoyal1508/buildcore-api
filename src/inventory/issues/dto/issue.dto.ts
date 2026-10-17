import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateIssueDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  siteId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  itemId!: string;

  @ApiProperty({ example: '2026-09-04' })
  @IsDateString()
  date!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  @Max(999_999_999_999_999)
  quantity!: number;

  @ApiPropertyOptional({
    description:
      'Who took the material. Optional when a vendor or subcontractor is named — ' +
      'their name is recorded instead.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  issuedTo?: string;

  @ApiPropertyOptional({
    description:
      "The project the material is issued for. Defaults to the store's own project.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  projectId?: string;

  @ApiPropertyOptional({
    description: 'The vendor or subcontractor who took the material',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  vendorId?: string;

  @ApiPropertyOptional({
    description:
      'The BOQ task group the material was consumed for. Optional: material must ' +
      'remain issuable at a project whose BOQ has not been loaded yet (FR-019).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  activityId?: string;

  @ApiPropertyOptional({
    example: 'JCB01/2027',
    description:
      'The machine the material went to — the issue slip\'s "Equipment No."',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  equipmentNo?: string;

  @ApiPropertyOptional({ description: 'The BOQ task item, if known' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  boqItemId?: string;

  @ApiPropertyOptional({ description: 'The approved indent line this fulfils' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  indentLineId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}

export class ListIssuesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  siteId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  itemId?: string;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

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

  @ApiPropertyOptional({ description: 'Cross-company callers only' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;
}

/**
 * Material coming back to the store (2026-10-15) — the daily issue register's "Received Qty",
 * "Returned On" and "Received By". `returnedQuantity` is the total returned against the issue so
 * far, so a second return is entered as the new total.
 */
export class ReturnIssueDto {
  /**
   * 036 M4: the quantity coming back *now*. Preferred over `returnedQuantity`, whose "total so far"
   * meaning confused people into entering what they were holding — and which, read by two
   * simultaneous requests, could not say whether they described one return or two.
   */
  @ApiPropertyOptional({
    description:
      'The quantity coming back now (036). Give this or `returnedQuantity`; when both are ' +
      'given they must agree.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  returnedNow?: number;

  @ApiPropertyOptional({
    description:
      'Total returned against this issue so far. Kept for older clients; prefer `returnedNow`.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(999_999_999_999_999)
  returnedQuantity?: number;

  @ApiProperty({ example: '2026-10-15' })
  @IsISO8601()
  returnedOn!: string;

  @ApiProperty({ description: 'Who received it at the store' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  receivedBy!: string;
}
