import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';

export class UpdateUserDto {
  @ApiPropertyOptional()
  @IsOptional()
  firstname?: string;

  @ApiPropertyOptional()
  @IsOptional()
  lastname?: string;
}
