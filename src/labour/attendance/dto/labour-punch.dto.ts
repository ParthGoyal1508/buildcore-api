import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LabourPunchType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class LabourPunchDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  siteId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  workerId!: string;

  @ApiProperty({ enum: LabourPunchType })
  @IsEnum(LabourPunchType)
  type!: LabourPunchType;

  @ApiProperty({
    description: 'Base64-encoded photo (data-URL prefix optional).',
  })
  @IsString()
  @IsNotEmpty()
  photo!: string;

  @ApiProperty({ example: 19.076 })
  @IsLatitude()
  latitude!: number;

  @ApiProperty({ example: 72.8777 })
  @IsLongitude()
  longitude!: number;

  @ApiPropertyOptional({
    description:
      'GPS accuracy radius in metres, judged exactly as an employee punch is (020 FR-012a).',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10_000)
  accuracyMeters?: number;
}

export class LabourDayQueryDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  siteId!: string;
}

export class LabourRefusalsQueryDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  siteId!: string;

  @ApiPropertyOptional({ description: 'Days back from today, default 7' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(92)
  days?: number;
}
