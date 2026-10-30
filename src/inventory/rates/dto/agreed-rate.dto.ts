import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

import { IsBase64Payload } from '../../../common/uploads/base64-payload';

/** The Vendor Rates sheet, as a base64 `.xlsx` (051). */
export class VendorRateImportDto {
  @ApiProperty({ description: 'Base64-encoded .xlsx workbook' })
  @IsBase64Payload()
  file!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  fileName?: string;
}

/** The agreed (028) rates in force (051): every pair, or one vendor's or one item's. */
export class ListAgreedRatesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  vendorId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  itemId?: string;

  @ApiPropertyOptional({ description: 'Cross-company callers: the company' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;
}
