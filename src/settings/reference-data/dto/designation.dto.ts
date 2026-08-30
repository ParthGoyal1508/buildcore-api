import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateDesignationDto {
  /** Only meaningful for a cross-company caller (see DocumentTypesService). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;

  @ApiProperty({ description: 'Unique per company' })
  @IsString()
  @IsNotEmpty()
  name: string;
}

export class UpdateDesignationDto extends PartialType(CreateDesignationDto) {}
