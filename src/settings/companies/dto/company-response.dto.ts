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
  /**
   * The account the payroll transfer is debited from (021 FR-008a).
   *
   * Not masked, unlike an employee's: this is the company's own account, named on every cheque it
   * writes, and the people who can read this endpoint are the people who sign them.
   */
  @ApiPropertyOptional() payrollDebitAccountNumber: string | null;
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
