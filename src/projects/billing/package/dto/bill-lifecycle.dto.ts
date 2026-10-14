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
  ValidateNested,
} from 'class-validator';

/** Certifying an issued bill (2026-10-13). Amounts are strings, as every money field here is. */
export class CertifyBillPackageDto {
  @ApiProperty({
    example: '1139971.00',
    description:
      'The figure certified — by the client’s engineer on a bill to the client, by the company on ' +
      'a subcontractor’s bill. Kept beside the billed figure, never instead of it.',
  })
  @IsNumberString()
  certifiedAmount: string;

  @ApiPropertyOptional({ example: 'Certified by AE, PWD Ajmer, MB page 42' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remarks?: string;
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
