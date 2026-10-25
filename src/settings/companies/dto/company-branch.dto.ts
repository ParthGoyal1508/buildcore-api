import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { GSTIN_REGEX } from './create-company.dto';

/** Empty strings from a form are "not given", not a value to store. */
const blankToUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;
const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() || undefined : value;

/** One GST registration of a company (041) — what the Branches section of company settings adds. */
export class CreateCompanyBranchDto {
  @ApiPropertyOptional({
    description: 'Short name for pickers; defaults to "City (State)"',
  })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;

  @ApiPropertyOptional({
    description: 'Name printed on documents; defaults to the company name',
  })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(200)
  tradeName?: string;

  @ApiPropertyOptional({
    description:
      '15-character GSTIN; its first two digits must match the state',
  })
  @Transform(upper)
  @IsOptional()
  @Matches(GSTIN_REGEX, { message: 'gstin is not a valid GSTIN' })
  gstin?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  address: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  city: string;

  @ApiProperty({ description: 'State name, e.g. "Gujarat"' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  state: string;

  @ApiProperty()
  @Matches(/^[0-9]{6}$/, { message: 'pinCode must be 6 digits' })
  pinCode: string;

  @ApiPropertyOptional()
  @Transform(blankToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(200)
  phone?: string;

  @ApiPropertyOptional()
  @Transform(blankToUndefined)
  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  email?: string;

  @ApiPropertyOptional()
  @Transform(blankToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;

  @ApiPropertyOptional()
  @Transform(blankToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  pfEstablishmentCode?: string;

  @ApiPropertyOptional()
  @Transform(blankToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  esicCode?: string;

  @ApiPropertyOptional()
  @Transform(blankToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  professionalTaxRegNumber?: string;
}

export class UpdateCompanyBranchDto extends PartialType(
  CreateCompanyBranchDto,
) {
  @ApiPropertyOptional({
    description: 'False deactivates; the head office cannot be deactivated',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CompanyBranchDto {
  @ApiProperty() id: string;
  @ApiProperty() companyId: string;
  @ApiProperty({ description: 'Label, or "City (State)" when none is set' })
  displayLabel: string;
  @ApiPropertyOptional({ nullable: true }) label: string | null;
  @ApiPropertyOptional({ nullable: true }) tradeName: string | null;
  @ApiPropertyOptional({ nullable: true }) gstin: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'GST state code derived from state',
  })
  stateCode: string | null;
  @ApiPropertyOptional({ nullable: true }) address: string | null;
  @ApiPropertyOptional({ nullable: true }) city: string | null;
  @ApiPropertyOptional({ nullable: true }) state: string | null;
  @ApiPropertyOptional({ nullable: true }) pinCode: string | null;
  @ApiPropertyOptional({ nullable: true }) phone: string | null;
  @ApiPropertyOptional({ nullable: true }) email: string | null;
  @ApiPropertyOptional({ nullable: true }) website: string | null;
  @ApiPropertyOptional({ nullable: true }) pfEstablishmentCode: string | null;
  @ApiPropertyOptional({ nullable: true }) esicCode: string | null;
  @ApiPropertyOptional({ nullable: true }) professionalTaxRegNumber:
    | string
    | null;
  @ApiProperty() isHeadOffice: boolean;
  @ApiProperty() isActive: boolean;
}

/** What a project / employee / letter form needs to offer a branch — no address, no codes. */
export class BranchOptionDto {
  @ApiProperty() id: string;
  @ApiProperty() label: string;
  @ApiPropertyOptional({ nullable: true }) gstin: string | null;
  @ApiPropertyOptional({ nullable: true }) state: string | null;
  @ApiProperty() isHeadOffice: boolean;
  @ApiProperty() isActive: boolean;
}

export class ListBranchOptionsQueryDto {
  @ApiPropertyOptional({
    description: 'For a cross-company caller; ignored otherwise',
  })
  @IsOptional()
  @IsString()
  companyId?: string;

  @ApiPropertyOptional({
    description: 'Include deactivated branches (for filters over history)',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}
