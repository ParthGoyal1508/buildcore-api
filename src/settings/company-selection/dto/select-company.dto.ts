import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/** Which company to work in (019 FR-008). */
export class SelectCompanyDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  companyId: string;
}
