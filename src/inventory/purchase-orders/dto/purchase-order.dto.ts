import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Filters for the structured PO list (036 M9). */
export class ListPurchaseOrdersDto {
  @ApiPropertyOptional({ description: 'Only POs placed on this vendor' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  vendorId?: string;
}

/** Filters for the purchase form's PO-line picker (036 M9). */
export class OpenPurchaseOrderLinesDto {
  @ApiPropertyOptional({
    description: 'Only lines of POs placed on this vendor',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  vendorId?: string;

  @ApiPropertyOptional({ description: 'Only lines ordering this item' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  itemId?: string;
}
