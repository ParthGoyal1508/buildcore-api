import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { ChargesBase, HireType, VendorType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import {
  GSTIN_REGEX,
  PAN_REGEX,
} from '../../../settings/companies/dto/create-company.dto';

export class VendorContactInput {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  email?: string;
}

export class VendorHireDetailInput {
  @ApiProperty({ enum: HireType })
  @IsEnum(HireType)
  hireType: HireType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  contractCode?: string;

  @ApiPropertyOptional({ description: 'ISO date' })
  @IsOptional()
  @IsDateString()
  periodFrom?: string;

  @ApiPropertyOptional({ description: 'ISO date' })
  @IsOptional()
  @IsDateString()
  periodTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  machineCategory?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  machineName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  requiredAvg?: number;

  @ApiPropertyOptional({ enum: ChargesBase })
  @IsOptional()
  @IsEnum(ChargesBase)
  chargesBase?: ChargesBase;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  rate?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(31)
  minWorkingDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowBdDays?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowIdleDays?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  operatorCharges?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  helperCharges?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  maintenanceCharges?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  fuelCharges?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  termsAndConditions?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  requirements?: string;
}

export class CreateVendorDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @ApiProperty({ enum: VendorType })
  @IsEnum(VendorType)
  type: VendorType;

  @ApiPropertyOptional({ description: '15-character GSTIN' })
  @IsOptional()
  @Matches(GSTIN_REGEX, { message: 'gstin is not a valid GSTIN' })
  gstin?: string;

  @ApiPropertyOptional({ description: '10-character PAN' })
  @IsOptional()
  @Matches(PAN_REGEX, { message: 'pan is not a valid PAN' })
  pan?: string;

  /**
   * Free text, not an enum. The Income Tax Act's section list changes between
   * finance acts, and a closed enum would reject a newly-notified section until the
   * next deploy — which is the wrong failure for a field an accountant reads off a
   * certificate.
   */
  @ApiPropertyOptional({ example: '194C' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  tdsSection?: string;

  @ApiPropertyOptional({ description: 'Percentage, e.g. 2 for 2%' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  tdsRate?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  state?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^[0-9]{6}$/, { message: 'pinCode must be 6 digits' })
  pinCode?: string;

  @ApiPropertyOptional({ default: 'INR' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  vendorCurrency?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  exchangeRate?: number;

  @ApiPropertyOptional({ type: [VendorContactInput] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VendorContactInput)
  contacts?: VendorContactInput[];

  @ApiPropertyOptional({
    type: [String],
    description: 'settings.VendorCategory ids this vendor deals in',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  categoryIds?: string[];

  @ApiPropertyOptional({ type: VendorHireDetailInput })
  @IsOptional()
  @ValidateNested()
  @Type(() => VendorHireDetailInput)
  hireDetail?: VendorHireDetailInput;
}

export class UpdateVendorDto extends PartialType(CreateVendorDto) {}
