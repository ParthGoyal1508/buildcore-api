import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** The query a PF / ESIC / PT challan is asked for with (041 made it a typed DTO). */
export class ChallanQueryDto {
  @ApiProperty({ example: '2026-09', description: 'Payroll period, YYYY-MM' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period must be YYYY-MM' })
  period!: string;

  @ApiPropertyOptional({
    description: 'For a cross-company caller; ignored otherwise',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;

  @ApiPropertyOptional({
    description:
      'One company branch — one PF / ESIC / PT establishment. Omitted → the whole company.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  branchId?: string;
}
