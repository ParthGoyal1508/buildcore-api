import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AssetAllocationStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { BooleanQuery } from '../../../common/decorators/boolean-query.decorator';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateAllocationDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  assetId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  projectId!: string;

  @ApiProperty({ description: 'Must be a site of the named project' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  siteId!: string;

  @ApiPropertyOptional({
    description:
      'Required when the asset’s category sets custodyRequired, and the employee ' +
      'must be posted at siteId (FR-010)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  custodianEmployeeId?: string;

  @ApiPropertyOptional({ default: 1, description: 'Bulk assets only' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(999_999_999_999_999)
  quantity?: number;

  @ApiProperty({ example: '2026-09-01' })
  @IsISO8601()
  allocatedFrom!: string;

  @ApiProperty({
    example: '2026-12-01',
    description: 'What the overdue-return reminder hangs off (FR-025)',
  })
  @IsISO8601()
  expectedReturnDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}

export class ReturnAllocationDto {
  @ApiProperty({ example: '2026-11-20' })
  @IsISO8601()
  actualReturnDate!: string;

  @ApiProperty({
    description:
      'The grade the asset came back in. Its isDamaged / isScrap flags decide the ' +
      'status the asset lands in (FR-015).',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  conditionOnReturnId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}

export class ListAllocationsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  assetId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  projectId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  siteId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  custodianEmployeeId?: string;

  @ApiPropertyOptional({ enum: AssetAllocationStatus })
  @IsOptional()
  @IsEnum(AssetAllocationStatus)
  status?: AssetAllocationStatus;

  @ApiPropertyOptional({
    description: 'Only allocations past their return date',
  })
  @IsOptional()
  @BooleanQuery()
  overdue?: boolean;

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
