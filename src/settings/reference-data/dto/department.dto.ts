import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateDepartmentDto {
  /** Only meaningful for a cross-company caller (see DocumentTypesService). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;

  @ApiProperty({ description: 'Unique per company' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;
}

export class UpdateDepartmentDto extends PartialType(CreateDepartmentDto) {}
