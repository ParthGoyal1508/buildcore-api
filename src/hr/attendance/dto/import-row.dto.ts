import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

import { LargeBody } from '../../../common/uploads/large-body';

/**
 * A bulk attendance upload (005 US13).
 *
 * The CSV arrives as a string in the body rather than as multipart, matching how
 * every other upload in this API is transported.
 *
 * `@LargeBody()`: a month of attendance for a few hundred people is well past the default
 * request-body limit, and a CSV is not base64, so it is marked explicitly (036 B8).
 */
@LargeBody()
export class AttendanceImportDto {
  @ApiProperty({
    description:
      'CSV contents. Columns: employeeCode, date, inTime, outTime, status, ' +
      'remarks — download the template for the exact header row.',
  })
  @IsString()
  @IsNotEmpty()
  csv: string;

  @ApiPropertyOptional({
    description: 'Required only for a cross-company caller.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;
}
