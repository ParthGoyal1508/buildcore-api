import { ApiProperty } from '@nestjs/swagger';
import { PunchType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class SubmitPunchDto {
  @ApiProperty({ enum: PunchType })
  @IsEnum(PunchType)
  type: PunchType;

  @ApiProperty({
    description: 'Base64-encoded photo (data-URL prefix optional).',
  })
  @IsString()
  @IsNotEmpty()
  photo: string;

  @ApiProperty({ example: 19.076 })
  @IsLatitude()
  latitude: number;

  @ApiProperty({ example: 72.8777 })
  @IsLongitude()
  longitude: number;

  @ApiProperty({
    description:
      'When the punch was taken, ISO 8601. May precede the request time for a punch queued while offline (research.md §4).',
    example: '2026-08-30T09:01:00.000Z',
  })
  @IsISO8601()
  capturedAt: string;
}

/** The punch result the contract returns — 201 even when a check produced an
 * exception, because the punch is recorded either way (FR-007). */
export class PunchResultDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: PunchType }) type: PunchType;
  @ApiProperty() capturedAt: string;
  @ApiProperty() isOfflineSync: boolean;
  @ApiProperty({ enum: ['matched', 'exception'] }) faceMatchResult: string;
  @ApiProperty({ enum: ['in_range', 'exception'] }) geofenceResult: string;
}

/**
 * An admin's verdict on a flagged punch.
 *
 * `IsIn` over the two terminal values rather than `IsEnum(ExceptionResolution)`:
 * that Prisma enum also contains `pending`, which is the state a punch arrives in,
 * not a decision anyone can submit. Validating against the full enum would let a
 * caller "resolve" an exception back to unresolved.
 */
export class ResolveExceptionDto {
  @ApiProperty({ enum: ['confirmed', 'rejected'] })
  @IsIn(['confirmed', 'rejected'])
  resolution: 'confirmed' | 'rejected';
}

/**
 * The month an attendance-history request is for.
 *
 * `@Type(() => Number)` because query parameters arrive as strings and the range
 * validators below would otherwise reject every request; the global ValidationPipe
 * runs with `transform: true`, which is what makes the conversion happen.
 */
export class AttendanceHistoryQueryDto {
  @ApiProperty({ minimum: 1, maximum: 12, example: 9 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  @ApiProperty({ minimum: 2000, maximum: 2999, example: 2026 })
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2999)
  year: number;
}
