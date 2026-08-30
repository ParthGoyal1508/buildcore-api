import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';

export class CreateDocumentTypeDto {
  /** Only meaningful for a cross-company caller; ignored for everyone else, who is
   * pinned to their own company. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;

  @ApiProperty({ description: 'Unique per company; normalized to uppercase' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9_]{2,40}$/, {
    message: 'code must be 2-40 letters, digits or underscores',
  })
  code: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ description: 'Gates attendance marking (FR-021)' })
  @IsOptional()
  @IsBoolean()
  isMandatory?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  hasExpiry?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  needsNumber?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** The derived display flag is deliberately absent — it is computed on read from
 * the three booleans and is never a request field (research.md §7). */
export class UpdateDocumentTypeDto extends PartialType(CreateDocumentTypeDto) {}
