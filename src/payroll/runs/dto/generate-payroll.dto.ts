import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PayrollRunStatus } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { EDITABLE_LINE_FIELDS } from '../../engine/payroll-computation';

export class GeneratePayrollDto {
  @ApiProperty({ example: '2026-08', description: 'Period key, YYYY-MM.' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period must be YYYY-MM' })
  period: string;

  @ApiPropertyOptional({
    description: 'Required only for a cross-company caller.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;

  @ApiPropertyOptional({
    description:
      '039: regenerate a draft that has hand corrections, discarding them. Without it such a ' +
      'draft refuses with 409 `PAYROLL_RUN_HAS_EDITS`.',
  })
  @IsOptional()
  @IsBoolean()
  discardEdits?: boolean;
}

/** 039: a hand correction to one generated payroll line. */
export class EditPayrollLineDto {
  @ApiProperty({
    description: `The new figures, \`{ field: amount }\`. Editable: ${EDITABLE_LINE_FIELDS.join(
      ', ',
    )}. Net pay is recomputed, never sent.`,
    example: { basic: 21000, tds: 500 },
  })
  @IsObject()
  changes: Record<string, number>;

  @ApiProperty({
    description: 'Why the line is being changed. Mandatory; kept per field.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  justification: string;
}

export class SetRunStatusDto {
  @ApiProperty({
    enum: [PayrollRunStatus.processed, PayrollRunStatus.paid],
    description:
      'Draft → processed freezes the figures; processed → paid records ' +
      'disbursement. Neither is reversible.',
  })
  @IsEnum(PayrollRunStatus)
  status: PayrollRunStatus;
}
