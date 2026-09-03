import { ApiPropertyOptional } from '@nestjs/swagger';
import { ClientStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';

/**
 * Query parameters for the client list.
 *
 * A DTO class rather than individual `@Query('status') status?: ClientStatus`
 * parameters, for the reason `ListVendorsDto` records: with `transform: true`, Nest
 * hands an absent value to class-transformer along with the enum as its metatype and
 * class-transformer dereferences it — two 005 endpoints returned 500 on a missing
 * query parameter for exactly this reason. A DTO class is always instantiable.
 */
export class ListClientsDto {
  @ApiPropertyOptional({ description: 'Matches name, contact person or GSTIN' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    enum: ClientStatus,
    description: 'Omit to see both active and inactive',
  })
  @IsOptional()
  @IsEnum(ClientStatus)
  status?: ClientStatus;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;

  @ApiPropertyOptional({ description: 'Cross-company callers only' })
  @IsOptional()
  @IsString()
  companyId?: string;
}
