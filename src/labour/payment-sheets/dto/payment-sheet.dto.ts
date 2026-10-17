import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  EngagementType,
  LabourPaymentMode,
  PaymentSheetStatus,
} from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class ListPaymentSheetsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  siteId?: string;

  @ApiPropertyOptional({ enum: EngagementType })
  @IsOptional()
  @IsEnum(EngagementType)
  engagementType?: EngagementType;

  @ApiPropertyOptional({ enum: PaymentSheetStatus })
  @IsOptional()
  @IsEnum(PaymentSheetStatus)
  status?: PaymentSheetStatus;
}

export class GeneratePaymentSheetDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;

  @ApiProperty({ description: 'The site whose labour the sheet pays (031)' })
  @IsString()
  @IsNotEmpty()
  siteId!: string;

  @ApiProperty({ example: '2026-09-01' })
  @IsDateString()
  periodFrom!: string;

  @ApiProperty({ example: '2026-09-07' })
  @IsDateString()
  periodTo!: string;

  @ApiPropertyOptional({ enum: EngagementType, default: EngagementType.direct })
  @IsOptional()
  @IsEnum(EngagementType)
  engagementType?: EngagementType;
}

export class ReopenPaymentSheetDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  reason!: string;
}

export class DisburseLineDto {
  @ApiProperty({ enum: LabourPaymentMode })
  @IsEnum(LabourPaymentMode)
  paymentMode!: LabourPaymentMode;

  @ApiProperty({ example: '2026-09-08' })
  @IsDateString()
  paidOn!: string;

  @ApiProperty({
    example: 800,
    description:
      "At most the line's net payable (036 O4); less needs shortPaymentReason and is carried to the next sheet",
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  paidAmount!: number;

  @ApiPropertyOptional({ description: 'Required for a cash disbursement' })
  @IsOptional()
  @IsString()
  acknowledgement?: string;

  @ApiPropertyOptional({
    description: 'Required when paidAmount differs from net',
  })
  @IsOptional()
  @IsString()
  shortPaymentReason?: string;
}

/** 036 O2: why a draft sheet is being deleted — optional, kept in the audit log. */
export class DeletePaymentSheetDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ReverseLineDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  reason!: string;
}
