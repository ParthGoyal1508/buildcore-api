import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AttendanceType, MusterStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class OpenMusterDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  siteId!: string;

  @ApiProperty({ example: '2026-09-04' })
  @IsDateString()
  date!: string;

  @ApiProperty()
  @IsLatitude()
  latitude!: number;

  @ApiProperty()
  @IsLongitude()
  longitude!: number;

  @ApiProperty({ example: 12.5 })
  @IsNumber()
  @Min(0)
  accuracyMetres!: number;

  @ApiPropertyOptional({
    description: 'Client capture time for an offline sync',
  })
  @IsOptional()
  @IsDateString()
  capturedAt?: string;
}

export class AddMusterLineDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  workerId!: string;

  @ApiProperty({ enum: AttendanceType })
  @IsEnum(AttendanceType)
  attendanceType!: AttendanceType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  overtimeHours?: number;

  @ApiPropertyOptional({ description: 'Base64/data-URL captured photo' })
  @IsOptional()
  @IsString()
  photo?: string;
}

export class BulkAddGangDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  gangId!: string;

  @ApiProperty({ enum: AttendanceType })
  @IsEnum(AttendanceType)
  attendanceType!: AttendanceType;
}

export class CaptureMusterLineDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  workerId!: string;

  @ApiProperty({ enum: AttendanceType })
  @IsEnum(AttendanceType)
  attendanceType!: AttendanceType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  overtimeHours?: number;

  @ApiProperty({ description: 'Base64/data-URL captured photo' })
  @IsString()
  @IsNotEmpty()
  photo!: string;
}

export class CaptureMusterDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  siteId!: string;

  @ApiProperty({ example: '2026-09-04' })
  @IsDateString()
  date!: string;

  @ApiProperty()
  @IsLatitude()
  latitude!: number;

  @ApiProperty()
  @IsLongitude()
  longitude!: number;

  @ApiProperty({ example: 12.5 })
  @IsNumber()
  @Min(0)
  accuracyMetres!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  capturedAt?: string;

  @ApiProperty({ type: [CaptureMusterLineDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CaptureMusterLineDto)
  lines!: CaptureMusterLineDto[];
}

export class ReturnMusterDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  reason!: string;
}

export class ListMustersDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;

  @ApiPropertyOptional({ enum: MusterStatus })
  @IsOptional()
  @IsEnum(MusterStatus)
  status?: MusterStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  siteId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  flagged?: boolean;
}
