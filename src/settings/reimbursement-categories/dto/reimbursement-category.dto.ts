import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

/** Per-company reimbursement category (005 FR-045, research.md §15). */
export class CreateReimbursementCategoryDto {
  @ApiProperty({ example: 'TRAVEL' })
  @Matches(/^[A-Za-z0-9_]{2,40}$/, {
    message: 'code must be 2-40 characters of letters, digits or underscore',
  })
  code: string;

  @ApiProperty({ example: 'Travel & Conveyance' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({
    description:
      'Claims above this amount must carry a receipt. Omit for never; 0 means ' +
      'every claim needs one — the two are deliberately different.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  receiptRequiredAbove?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Required only for a cross-company caller.' })
  @IsOptional()
  @IsString()
  companyId?: string;
}

export class UpdateReimbursementCategoryDto extends PartialType(
  CreateReimbursementCategoryDto,
) {}
