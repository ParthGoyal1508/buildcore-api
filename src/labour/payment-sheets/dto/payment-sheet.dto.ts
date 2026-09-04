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

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @ApiProperty({ example: '2026-09-01' })
  @IsDateString()
  periodFrom!: string;

  @ApiProperty({ example: '2026-09-07' })
  @IsDateString()
  periodTo!: string;

  @ApiProperty({ enum: EngagementType })
  @IsEnum(EngagementType)
  engagementType!: EngagementType;
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

  @ApiProperty({ example: 800 })
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

export class ReverseLineDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  reason!: string;
}
