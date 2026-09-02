import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** Moving an employee to another company (005 US8, FR-007). */
export class TransferEmployeeDto {
  @ApiProperty({ description: 'Destination company.' })
  @IsString()
  @IsNotEmpty()
  toCompanyId: string;

  @ApiProperty({ example: '2026-10-01' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'transferDate must be YYYY-MM-DD',
  })
  transferDate: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  reason: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Keep the existing employee code. Off by default: a code carries its ' +
      'company’s short code as a prefix, so retaining it leaves the identifier ' +
      'disagreeing with the company the employee is now in.',
  })
  @IsOptional()
  @IsBoolean()
  retainCode?: boolean;
}
