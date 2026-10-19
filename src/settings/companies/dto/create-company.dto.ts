import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CompanyStatus, PayCycle } from '@prisma/client';
import {
  IsEmail,
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
} from 'class-validator';

/**
 * Published statutory formats (research.md §10). Validated at the DTO boundary so a
 * malformed code fails fast here rather than silently breaking downstream Challan
 * generation, which the PRD says depends on these being well-formed.
 */
export const GSTIN_REGEX =
  /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
export const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

export class CreateCompanyDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  /** Normalized to trimmed uppercase by the service; uniqueness is case-insensitive (FR-004). */
  @ApiProperty({
    description: 'Unique short code; drives employee code generation',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9-]{2,10}$/, {
    message: 'shortCode must be 2-10 letters, digits or hyphens',
  })
  @MaxLength(200)
  shortCode: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  logoUrl?: string;

  @ApiPropertyOptional({ enum: CompanyStatus })
  @IsOptional()
  @IsEnum(CompanyStatus)
  status?: CompanyStatus;

  @ApiPropertyOptional({ description: '15-character GSTIN' })
  @IsOptional()
  @Matches(GSTIN_REGEX, { message: 'gstin is not a valid GSTIN' })
  gstin?: string;

  @ApiPropertyOptional({ description: '10-character PAN' })
  @IsOptional()
  @Matches(PAN_REGEX, { message: 'pan is not a valid PAN' })
  pan?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  cin?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  tan?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  state?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^[0-9]{6}$/, { message: 'pinCode must be 6 digits' })
  pinCode?: string;

  /** Printed at the head of a work order or purchase order (2026-10-14). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  website?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  pfEstablishmentCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  esicCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  professionalTaxRegNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  bocwRegNumber?: string;

  @ApiPropertyOptional({ enum: PayCycle })
  @IsOptional()
  @IsEnum(PayCycle)
  payCycle?: PayCycle;

  @ApiPropertyOptional({ description: 'Day-of-month attendance edits lock' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  payrollLockDay?: number;

  // Each rate defaults from SettingsConfig when omitted (FR-002, research.md §11),
  // and stays per-company editable afterwards.
  @ApiPropertyOptional({
    description: 'Percent; defaults from config when omitted',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  pfEmployerRate?: number;

  @ApiPropertyOptional({
    description: 'Percent; defaults from config when omitted',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  esicEmployerRate?: number;

  @ApiPropertyOptional({
    description: 'Percent; defaults from config when omitted',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  gratuityRate?: number;

  @ApiPropertyOptional({
    description: 'Percent; defaults from config when omitted',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  bonusRate?: number;

  @ApiPropertyOptional({
    description:
      'Overtime pay multiplier applied to the derived hourly rate (FR-014a). ' +
      'Defaults to 2.00 when omitted. Not a percent — a multiplier.',
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10)
  otMultiplier?: number;

  @ApiPropertyOptional({
    description:
      'The company’s own account the payroll transfer is debited from (021 FR-008a). A **string**, ' +
      'because an account number’s leading zero is part of it — the client’s own sample debits ' +
      '`09310400000819`. The bank transfer sheet refuses to generate without this, since every row ' +
      'names the account the money leaves from.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  payrollDebitAccountNumber?: string;
}
