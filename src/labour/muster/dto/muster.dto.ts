import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MusterStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class ReturnMusterDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2_000)
  reason!: string;
}

export class ListMustersDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;

  @ApiPropertyOptional({ enum: MusterStatus })
  @IsOptional()
  @IsEnum(MusterStatus)
  status?: MusterStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  siteId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  flagged?: boolean;
}
