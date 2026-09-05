import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/** Query for `GET /group/employees/search` — the search term. */
export class EmployeeSearchQueryDto {
  @ApiProperty({
    description:
      'Search term, matched against employee name and code across accessible ' +
      'companies. At least two characters.',
    minLength: 2,
  })
  @IsString()
  @MinLength(2, { message: 'Search term must be at least 2 characters.' })
  q!: string;
}
