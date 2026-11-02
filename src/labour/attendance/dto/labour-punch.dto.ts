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
  MaxLength,
  Min,
} from 'class-validator';

export class LabourPunchDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  siteId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  workerId!: string;

  @ApiProperty({ enum: LabourPunchType })
  @IsEnum(LabourPunchType)
  type!: LabourPunchType;

  @ApiProperty({
    description:
      'The liveness challenge this capture followed (057, flow `labour-punch` for this workerId). ' +
      'The photos are the multipart `frames`, in its step order.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  challengeId!: string;

  // Multipart fields arrive as text (057).
  @ApiProperty({ example: 19.076 })
  @Type(() => Number)
  @IsLatitude()
  latitude!: number;

  @ApiProperty({ example: 72.8777 })
  @Type(() => Number)
  @IsLongitude()
  longitude!: number;

  @ApiPropertyOptional({
    description:
      'GPS accuracy radius in metres, judged exactly as an employee punch is (020 FR-012a).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(10_000)
  accuracyMeters?: number;
}

export class LabourDayQueryDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  siteId!: string;
}

export class LabourRefusalsQueryDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  siteId!: string;

  @ApiPropertyOptional({ description: 'Days back from today, default 7' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(92)
  days?: number;
}
