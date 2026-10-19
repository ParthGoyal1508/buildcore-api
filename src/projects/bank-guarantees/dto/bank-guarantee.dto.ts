import {
  ApiProperty,
  ApiPropertyOptional,
  PartialType,
  OmitType,
} from '@nestjs/swagger';
import { BankGuaranteeType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { IsBase64Payload } from '../../../common/uploads/base64-payload';

/**
 * Request bodies for the Bank Guarantees register (037, specs/037-bank-guarantees/spec.md).
 *
 * Amounts are strings, as every money field in Projects is: the columns are `Decimal(16,2)` and
 * a JSON number cannot carry every paisa exactly. Optional fields accept `null` to clear them.
 */

export class CreateBgTenderDto {
  @ApiProperty({
    example: 'Operation and Maintenance of NH-148A from junction of NH-48 …',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  workName!: string;

  @ApiProperty({ example: 'NHAI DELHI' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  departmentName!: string;

  @ApiPropertyOptional({ example: '204300000.00' })
  @IsOptional()
  @IsNumberString()
  tenderAmount?: string | null;

  @ApiPropertyOptional({
    description: 'The project this tender became, if any.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  projectId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  remarks?: string | null;
}

export class UpdateBgTenderDto extends PartialType(CreateBgTenderDto) {}

export const BG_STATUS_FILTERS = [
  'expiring',
  'running',
  'expired',
  'released',
  'encashed',
] as const;
export type BgStatusFilter = (typeof BG_STATUS_FILTERS)[number];

export class ListBgTendersDto {
  @ApiPropertyOptional({
    description: 'Work name, department, bank or BG number.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({
    enum: BG_STATUS_FILTERS,
    description:
      'Tenders holding at least one guarantee in this state. `expiring`: Running and live until ' +
      'within the next 30 days, or already past it.',
  })
  @IsOptional()
  @IsIn(BG_STATUS_FILTERS)
  status?: BgStatusFilter;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  projectId?: string;

  @ApiPropertyOptional({
    description: 'A cross-company caller may name the company.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  companyId?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class ExportBgTendersDto extends OmitType(ListBgTendersDto, [
  'page',
  'pageSize',
] as const) {}

export class CreateBankGuaranteeDto {
  @ApiProperty({ enum: BankGuaranteeType, example: 'EMD' })
  @IsEnum(BankGuaranteeType)
  type!: BankGuaranteeType;

  @ApiPropertyOptional({
    example: '0931IGP003835826',
    description:
      'Blank while applied for. Once entered, issue and expiry dates are required.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  bgNumber?: string | null;

  @ApiProperty({ example: '800000.00' })
  @IsNumberString()
  amount!: string;

  @ApiPropertyOptional({ example: '2026-06-17' })
  @IsOptional()
  @IsDateString()
  issueDate?: string | null;

  @ApiPropertyOptional({ example: '2026-11-30' })
  @IsOptional()
  @IsDateString()
  expiryDate?: string | null;

  @ApiPropertyOptional({
    description: 'On or after the expiry date. Alerts run to this date.',
  })
  @IsOptional()
  @IsDateString()
  claimPeriodEndDate?: string | null;

  @ApiPropertyOptional({ example: 'ICICI Bank' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  issuingBank?: string | null;

  @ApiPropertyOptional({ example: 'Connaught Place, New Delhi' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  issuingBranch?: string | null;

  @ApiPropertyOptional({ example: '80000.00' })
  @IsOptional()
  @IsNumberString()
  marginAmount?: string | null;

  @ApiPropertyOptional({ example: 'FD 1234567890' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  fdReference?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  remarks?: string | null;
}

/** Everything but the type: an EMD does not become a PBG — that is a new guarantee. */
export class UpdateBankGuaranteeDto extends PartialType(
  OmitType(CreateBankGuaranteeDto, ['type'] as const),
) {}

export class ExtendBankGuaranteeDto {
  @ApiProperty({
    example: '2027-03-31',
    description: 'Later than the current expiry.',
  })
  @IsDateString()
  expiryDate!: string;

  @ApiPropertyOptional({
    description: 'Moves with the extension when the guarantee has one.',
  })
  @IsOptional()
  @IsDateString()
  claimPeriodEndDate?: string | null;

  @ApiPropertyOptional({
    example: 'Extended at NHAI’s request, letter dated 12.11.2026.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ReleaseBankGuaranteeDto {
  @ApiProperty({
    example: '2026-12-02',
    description: 'When the department returned it.',
  })
  @IsDateString()
  releasedOn!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class EncashBankGuaranteeDto {
  @ApiProperty({ example: '2026-12-02' })
  @IsDateString()
  encashedOn!: string;

  @ApiProperty({
    example: '800000.00',
    description: 'What the department invoked; up to the BG amount.',
  })
  @IsNumberString()
  encashedAmount!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ReopenBankGuaranteeDto {
  @ApiProperty({ example: 'Release recorded against the wrong BG.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  note!: string;
}

export class UploadBankGuaranteeDocumentDto {
  @ApiProperty({ example: 'BG copy' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title!: string;

  @ApiProperty({
    description:
      'The file, base64-encoded. PDF or image; images are compressed.',
  })
  @IsBase64Payload()
  data!: string;

  @ApiProperty({ example: 'application/pdf' })
  @IsString()
  @MaxLength(120)
  contentType!: string;

  @ApiPropertyOptional({ example: 'BG 0931IGP003835826.pdf' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;
}
