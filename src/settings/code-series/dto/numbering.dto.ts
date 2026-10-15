import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * One series' format in Settings → Numbering. Counted series (projects, vendors, work orders) use
 * `prefix`, `base`, `step` and `width`; machines and assets use `width` (serial digits) and
 * `separator`. The ranges are checked by `NumberingService`, which knows which series is which.
 */
export class SetNumberingDto {
  @ApiPropertyOptional({ example: '2022', description: 'Fixed leading text.' })
  @IsOptional()
  @IsString()
  @MaxLength(12)
  prefix?: string;

  @ApiPropertyOptional({
    example: 1000,
    description: 'The number counted from. The first code is start + gap.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  base?: number;

  @ApiPropertyOptional({ example: 10, description: 'The gap between codes.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  step?: number;

  @ApiPropertyOptional({ example: 3, description: 'Digits, zero-padded.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  width?: number;

  @ApiPropertyOptional({ example: '/', description: 'Machines and assets.' })
  @IsOptional()
  @IsString()
  @MaxLength(1)
  separator?: string;
}
