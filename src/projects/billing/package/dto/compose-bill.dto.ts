import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BillDirection } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Opening a package for a project and a period (023 FR-001).
 *
 * **There is no quantity, no rate and no total on this shape, and that is the guarantee.**
 * `whitelist` and `forbidNonWhitelisted` are both on in `configure-app.ts`, so a caller sending a
 * computed figure gets a 400 rather than having it stripped — which 022 found is the stronger
 * promise of the two, because stripping is invisible to the sender. Every quantity here is proposed
 * by the server from feature 022's approved measurement, and every rate is read from the schedule
 * or the contract.
 */
export class ComposeBillPackageDto {
  @ApiProperty({
    enum: BillDirection,
    description:
      'Which way the bill points. `to_client` measures the project’s own BOQ at the client’s ' +
      'rates; `to_subcontractor` measures that subcontractor’s award lines at the awarded rates. ' +
      'These are different schedules, which is why the direction is chosen here and not inferred.',
  })
  @IsEnum(BillDirection)
  direction: BillDirection;

  @ApiProperty({
    example: '2025-12-21',
    description: 'First day of the period, **inclusive**.',
  })
  @IsDateString()
  periodFrom: string;

  @ApiProperty({
    example: '2026-01-20',
    description:
      'Last day of the period, **inclusive**. The client’s cycle runs the 21st to the 20th, so a ' +
      'period is two dates and not a month anybody can derive from one.',
  })
  @IsDateString()
  periodTo: string;

  @ApiPropertyOptional({
    description:
      'The work order whose award lines this bill measures. **Required** when the direction is ' +
      '`to_subcontractor`: without it there is no schedule to propose against.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  workOrderId?: string;

  @ApiPropertyOptional({
    example: '0016014256/12',
    description:
      'The counterparty’s own reference for this bill. Recorded, never generated — it belongs to ' +
      'their system and inventing one would make two documents disagree.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  externalBillNo?: string;

  @ApiPropertyOptional({
    example: '16014256',
    description:
      'The counterparty’s own work-order reference. Recorded, never generated.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  externalWorkOrderNo?: string;
}
