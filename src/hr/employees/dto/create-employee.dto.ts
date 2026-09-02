import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MaxLength,
  ValidateIf,
} from 'class-validator';

import {
  CalculationMode,
  EmploymentType,
  Gender,
  MaritalStatus,
} from '@prisma/client';

/**
 * The eight-tab employee form (005 US1), as one DTO.
 *
 * One DTO rather than eight nested ones because the tabs are a presentation
 * grouping, not a domain boundary — the API takes and returns a whole employee, and
 * splitting it would force the client to assemble a payload whose shape matched a
 * UI layout rather than the record.
 *
 * Regulated PII (Aadhaar, PAN, bank account) is accepted here in plaintext over
 * TLS and encrypted by the service before it reaches a column — see
 * PiiCipherService. It is never returned in this shape.
 */
export class CreateEmployeeDto {
  // ── Required linkage (carried from 003's minimal model) ────────────────────

  @ApiProperty({ description: 'Site the employee is posted at.' })
  @IsString()
  @IsNotEmpty()
  siteId: string;

  @ApiProperty({ description: 'Shift whose duration overtime is computed against.' })
  @IsString()
  @IsNotEmpty()
  shiftId: string;

  // ── Tab 1: Identity ───────────────────────────────────────────────────────

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @ApiPropertyOptional({ description: 'Mr / Ms / Dr etc.' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  title?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  dob?: string;

  @ApiPropertyOptional({ enum: Gender })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @ApiPropertyOptional({ enum: MaritalStatus })
  @IsOptional()
  @IsEnum(MaritalStatus)
  maritalStatus?: MaritalStatus;

  @ApiPropertyOptional({ description: 'Object-storage reference for the photo.' })
  @IsOptional()
  @IsString()
  photoRef?: string;

  // ── Tab 2: Employment ─────────────────────────────────────────────────────

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  departmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  designationId?: string;

  @ApiPropertyOptional({ enum: EmploymentType })
  @IsOptional()
  @IsEnum(EmploymentType)
  employmentType?: EmploymentType;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  dateOfJoining?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  probationEndDate?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  confirmationDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reportingToEmployeeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  musterCategory?: string;

  @ApiPropertyOptional({ description: 'Standard hours per working day.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(24)
  hoursPerDay?: number;

  @ApiPropertyOptional({ description: 'Required when calculationMode is `daily`.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  dailyRate?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  payMode?: string;

  @ApiPropertyOptional({ enum: CalculationMode })
  @IsOptional()
  @IsEnum(CalculationMode)
  calculationMode?: CalculationMode;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  workmanId?: string;

  // ── Tab 3: Statutory ──────────────────────────────────────────────────────
  //
  // Conditional validation (T020): switching PF or ESIC on makes its identifying
  // number mandatory. A contribution cannot be filed against a blank number, so
  // accepting one here only defers the failure to challan generation, where it is
  // far more expensive to discover.

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  pfApplicable?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  pfUpperLimit?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  esicApplicable?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  esicUpperLimit?: boolean;

  @ApiPropertyOptional({ description: '12-digit UAN. Required when PF applies.' })
  @ValidateIf((o: CreateEmployeeDto) => o.pfApplicable === true)
  @IsString()
  @Matches(/^\d{12}$/, { message: 'uan must be exactly 12 digits' })
  uan?: string;

  @ApiPropertyOptional({ description: 'Required when PF applies.' })
  @ValidateIf((o: CreateEmployeeDto) => o.pfApplicable === true)
  @IsString()
  @IsNotEmpty({ message: 'pfNumber is required when pfApplicable is true' })
  pfNumber?: string;

  @ApiPropertyOptional({ description: 'Required when ESIC applies.' })
  @ValidateIf((o: CreateEmployeeDto) => o.esicApplicable === true)
  @IsString()
  @IsNotEmpty({ message: 'esicNumber is required when esicApplicable is true' })
  esicNumber?: string;

  @ApiPropertyOptional({
    description: 'Regulated PII — encrypted at rest, masked on every read.',
  })
  @IsOptional()
  @Matches(/^\d{12}$/, { message: 'aadhaar must be exactly 12 digits' })
  aadhaar?: string;

  @ApiPropertyOptional({
    description: 'Regulated PII — encrypted at rest, masked on every read.',
  })
  @IsOptional()
  @Matches(/^[A-Z]{5}\d{4}[A-Z]$/, {
    message: 'pan must match the format AAAAA9999A',
  })
  pan?: string;

  // ── Tab 4: Pay & Bank ─────────────────────────────────────────────────────

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  basic?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  hra?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  conveyanceAllowance?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  siteAllowance?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  specialAllowance?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  paymentMode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  bankName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  bankBranch?: string;

  @ApiPropertyOptional({
    description: 'Regulated PII — encrypted at rest, masked on every read.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  bankAccountNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^[A-Z]{4}0[A-Z0-9]{6}$/, {
    message: 'ifscCode must match the format AAAA0XXXXXX',
  })
  ifscCode?: string;

  // ── Tab 5: Contact ────────────────────────────────────────────────────────

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^\d{10}$/, { message: 'mobile must be exactly 10 digits' })
  mobile?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^\d{10}$/, { message: 'alternateMobile must be exactly 10 digits' })
  alternateMobile?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  presentAddress?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  presentCity?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  presentState?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^\d{6}$/, { message: 'presentPinCode must be exactly 6 digits' })
  presentPinCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  permanentAddress?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  permanentCity?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  permanentState?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^\d{6}$/, { message: 'permanentPinCode must be exactly 6 digits' })
  permanentPinCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  emergencyContactName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  emergencyContactRelation?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^\d{10}$/, {
    message: 'emergencyContactPhone must be exactly 10 digits',
  })
  emergencyContactPhone?: string;

  // ── Tab 6: Letters ────────────────────────────────────────────────────────

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  offerLetterIssued?: boolean;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  offerLetterIssuedDate?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  appointmentLetterIssued?: boolean;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  appointmentLetterIssuedDate?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  ndaSigned?: boolean;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  ndaSignedDate?: string;

  // ── Tab 7: Onboarding checklist ───────────────────────────────────────────

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  idCardIssued?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  uniformProvided?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  safetyInductionCompleted?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  toolsIssued?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  bankVerificationDone?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  biometricEnrolled?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  siteAccessGranted?: boolean;
}

/** Query filters for the employee list (US1: search/department/site/status). */
export class ListEmployeesQueryDto {
  @ApiPropertyOptional({ description: 'Matches employee code, first or last name.' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  departmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  siteId?: string;

  @ApiPropertyOptional({ description: 'Defaults to active-only when omitted.' })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  isActive?: boolean;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ default: 25, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  pageSize?: number;
}

/** The single PII field a reveal request names (005 FR-003, research.md §3). */
export class RevealPiiDto {
  @ApiProperty({ enum: ['aadhaar', 'pan', 'bankAccountNumber', 'uan'] })
  @IsEnum(['aadhaar', 'pan', 'bankAccountNumber', 'uan'] as never)
  field: 'aadhaar' | 'pan' | 'bankAccountNumber' | 'uan';
}
