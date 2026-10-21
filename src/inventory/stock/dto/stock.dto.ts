import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { BooleanQuery } from '../../../common/decorators/boolean-query.decorator';
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ListStockDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  siteId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Matches item name or code' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ description: 'Only rows below their reorder level' })
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  belowReorderLevel?: boolean;

  @ApiPropertyOptional({
    description:
      'Only item-stores with stock on hand (039) — the issue form offers nothing it cannot issue',
  })
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  inStockOnly?: boolean;

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

/** One item's ledger at one store over a date range (036 M13). Both ends optional. */
export class StockLedgerQueryDto {
  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-10-31' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({ description: 'Cross-company callers only' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;
}

/** The ledger download: the item and store, then the same range (036 M13). */
export class StockLedgerExportDto extends StockLedgerQueryDto {
  @ApiProperty()
  @IsString()
  @MaxLength(100)
  itemId!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(100)
  siteId!: string;
}
