import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BillDeductionSection } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsBase64Payload } from '../../../../common/uploads/base64-payload';

import { CertifiedLineDto } from '../../dto/client-bill.dto';

/** Certifying an issued bill (2026-10-13). Amounts are strings, as every money field here is. */
export class CertifyBillPackageDto {
  @ApiProperty({
    example: '1139971.00',
    description:
      'The figure certified — by the client’s engineer on a bill to the client, by the company on ' +
      'a subcontractor’s bill. Kept beside the billed figure, never instead of it.\n\n' +
      '**Ignored when `lines` are given** (2026-10-15) — the figure is then derived from them — ' +
      'and required otherwise.',
  })
  @ValidateIf((dto: CertifyBillPackageDto) => !dto.lines)
  @IsNumberString()
  certifiedAmount?: string;

  @ApiPropertyOptional({
    type: [CertifiedLineDto],
    description:
      'What the client certified, line by line (2026-10-15) — read from the certified copy or ' +
      'typed in. **Bill to the client only.** Each line no more than it was billed at; zero is ' +
      'meaningful and returns the line’s quantity to the outstanding BOQ. Lines left out are “not ' +
      'said” and keep their billed quantity. Certifying again replaces the earlier answer.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => CertifiedLineDto)
  lines?: CertifiedLineDto[];

  @ApiPropertyOptional({ example: 'Certified by AE, PWD Ajmer, MB page 42' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remarks?: string;

  @ApiPropertyOptional({
    description:
      'The certified copy, base64-encoded (PDF, image or spreadsheet). On a bill to the client, ' +
      'the client’s certification document, replacing any copy already held. On a ' +
      'subcontractor’s bill (2026-10-14), filed as a signed copy of its RA bill.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2_000)
  @IsBase64Payload()
  certificateData?: string;

  @ApiPropertyOptional({ example: 'RA-09 certification.pdf' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  certificateFileName?: string;
}

/**
 * A certified copy, sent to be read for its quantities — nothing is written (2026-10-15). Sent
 * without a file, the bill's lines come back for entering the certified quantities by hand.
 */
export class ReadCertifiedCopyDto {
  @ApiPropertyOptional({
    description:
      'The certified copy, base64-encoded. A workbook (.xls / .xlsx) is read; a PDF or an image ' +
      'comes back unreadable, with every line listed for manual entry. Omitted: the lines alone.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @IsBase64Payload()
  data?: string;

  @ApiPropertyOptional({ example: 'RA-04 certified.xlsx' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName?: string;
}

export class ReviseBillPackageDto {
  @ApiProperty({ example: 'Client asked for chainage-wise split of item 4.2' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason: string;
}

export class WithdrawBillPackageDto {
  @ApiPropertyOptional({ example: 'Diesel recovery missed' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class MarkBillSharedDto {
  @ApiPropertyOptional({
    example: 'accounts@hginfra.com; hard copy to site office',
    description:
      'Who it went to and how. Free text — it went by email, WhatsApp or on paper.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  sharedTo?: string;
}

export class BillDeductionLineDto {
  @ApiProperty({ enum: BillDeductionSection })
  @IsEnum(BillDeductionSection)
  section: BillDeductionSection;

  @ApiProperty({ example: 'Recovery of Diesel' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  label: string;

  @ApiProperty({ example: '25000.00' })
  @IsNumberString()
  amount: string;
}

/** The whole list of a subcontractor bill's own recovery / deduction lines, replaced at once. */
export class SetBillDeductionLinesDto {
  @ApiProperty({ type: [BillDeductionLineDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BillDeductionLineDto)
  lines: BillDeductionLineDto[];
}
