import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * A bulk attendance upload (005 US13).
 *
 * The CSV arrives as a string in the body rather than as multipart, matching how
 * every other upload in this API is transported.
 */
export class AttendanceImportDto {
  @ApiProperty({
    description:
      'CSV contents. Columns: employeeCode, date, inTime, outTime, status, ' +
      'remarks — download the template for the exact header row.',
  })
  @IsString()
  @IsNotEmpty()
  csv: string;

  @ApiPropertyOptional({ description: 'Required only for a cross-company caller.' })
  @IsOptional()
  @IsString()
  companyId?: string;
}
