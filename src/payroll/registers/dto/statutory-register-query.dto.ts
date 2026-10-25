import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Which part of the establishment a statutory register covers (041 made it a typed DTO). */
export class StatutoryRegisterQueryDto {
  @ApiPropertyOptional({
    description: 'Employees at this project’s sites only',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  projectId?: string;

  @ApiPropertyOptional({ description: 'Employees at this site only' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  siteId?: string;

  @ApiPropertyOptional({
    description:
      'One company branch — one PF / ESIC establishment, whose address and codes head the register',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  branchId?: string;
}
