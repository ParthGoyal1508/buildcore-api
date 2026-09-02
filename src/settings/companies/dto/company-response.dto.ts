import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Company, CompanyStatus, PayCycle } from '@prisma/client';

/** Serializes a Company for the wire. Exists chiefly to turn Prisma `Decimal` rate
 * columns into plain JSON numbers — without it they serialize as objects. */
export class CompanyResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() shortCode: string;
  @ApiPropertyOptional() logoUrl: string | null;
  @ApiProperty({ enum: CompanyStatus }) status: CompanyStatus;
  @ApiPropertyOptional() gstin: string | null;
  @ApiPropertyOptional() pan: string | null;
  @ApiPropertyOptional() cin: string | null;
  @ApiPropertyOptional() tan: string | null;
  @ApiPropertyOptional() address: string | null;
  @ApiPropertyOptional() city: string | null;
  @ApiPropertyOptional() state: string | null;
  @ApiPropertyOptional() pinCode: string | null;
  @ApiPropertyOptional() pfEstablishmentCode: string | null;
  @ApiPropertyOptional() esicCode: string | null;
  @ApiPropertyOptional() professionalTaxRegNumber: string | null;
  @ApiPropertyOptional() bocwRegNumber: string | null;
  @ApiProperty({ enum: PayCycle }) payCycle: PayCycle;
  @ApiProperty() payrollLockDay: number;
  @ApiProperty() pfEmployerRate: number;
  @ApiProperty() esicEmployerRate: number;
  @ApiProperty() gratuityRate: number;
  @ApiProperty() bonusRate: number;
  /** Overtime pay multiplier (005 FR-014a) — a multiplier, not a percent. */
  @ApiProperty() otMultiplier: number;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;

  static fromEntity(company: Company): CompanyResponseDto {
    return {
      ...company,
      pfEmployerRate: company.pfEmployerRate.toNumber(),
      esicEmployerRate: company.esicEmployerRate.toNumber(),
      gratuityRate: company.gratuityRate.toNumber(),
      bonusRate: company.bonusRate.toNumber(),
      otMultiplier: company.otMultiplier.toNumber(),
    };
  }
}
