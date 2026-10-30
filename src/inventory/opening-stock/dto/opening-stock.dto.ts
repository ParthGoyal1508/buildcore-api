import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import { IsBase64Payload } from '../../../common/uploads/base64-payload';

/** The opening stock list (051): every entry of the company, or one store's. */
export class ListOpeningStockDto {
  @ApiPropertyOptional({ description: 'One store (site)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  siteId?: string;

  @ApiPropertyOptional({ description: 'Cross-company callers: the company' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;
}

/** The figures an opening entry carries, shared by add and replace. */
class OpeningFiguresDto {
  @ApiProperty({ description: 'Quantity in the item’s unit; more than 0' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  @Max(999_999_999_999_999)
  quantity!: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      '₹ per unit. Omit or null when not known: the stock is valued at 0 and shown as "no rate".',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999_999)
  rate?: number | null;

  @ApiPropertyOptional({
    description:
      'YYYY-MM-DD, the day the stock was counted. Defaults to today (business time zone); not in the future.',
  })
  @IsOptional()
  @IsDateString()
  asOnDate?: string;
}

/** One opening entry (051). One per item per store: a second is refused until the first is replaced. */
export class CreateOpeningStockDto extends OpeningFiguresDto {
  @ApiProperty({ description: 'The store (site)' })
  @IsString()
  @MaxLength(100)
  siteId!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(100)
  itemId!: string;
}

/** Replaces an opening entry's figures; allowed only while nothing has moved at that store since. */
export class ReplaceOpeningStockDto extends OpeningFiguresDto {}

/** The Opening Stock sheet, as a base64 `.xlsx` (051). */
export class OpeningStockImportDto {
  @ApiProperty({ description: 'Base64-encoded .xlsx workbook' })
  @IsBase64Payload()
  file!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  fileName?: string;
}

export class ConfirmOpeningStockImportDto extends OpeningStockImportDto {
  @ApiPropertyOptional({
    description:
      'Required when any row names an item and store that already have an opening entry: those ' +
      'entries are replaced.',
  })
  @IsOptional()
  @IsBoolean()
  replaceExisting?: boolean;
}
