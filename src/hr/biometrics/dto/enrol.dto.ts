import { ApiProperty } from '@nestjs/swagger';
import { ConsentMethod } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsEnum,
  IsString,
} from 'class-validator';

/**
 * Photos arrive as base64 strings rather than multipart.
 *
 * The capture surface is a mobile web app taking canvas snapshots, which already
 * holds the frames in memory as data URLs — base64 keeps a single JSON body with a
 * uniform validation path, where multipart would need separate parsing and its own
 * size handling for a payload of a few hundred kilobytes.
 */
export class EnrolFaceDto {
  @ApiProperty({
    description: 'Base64-encoded JPEG/PNG photos (data-URL prefix optional).',
    type: [String],
    minItems: 3,
    maxItems: 5,
  })
  @IsArray()
  // Bounds are declared here as literals because Swagger and class-validator both
  // need them at decoration time, before ConfigService exists. FaceEnrolmentService
  // re-checks against the configured values, which stay the single source of truth.
  @ArrayMinSize(3, { message: 'At least 3 photos are required to enrol.' })
  @ArrayMaxSize(5, { message: 'At most 5 photos may be submitted.' })
  @IsString({ each: true })
  photos: string[];

  @ApiProperty({ enum: ConsentMethod })
  @IsEnum(ConsentMethod)
  consentMethod: ConsentMethod;

  @ApiProperty({
    description:
      'Must be exactly true. Biometric enrolment without recorded consent is not permitted (FR-002).',
  })
  // `Equals(true)` rather than `IsBoolean()`: the point is not that a boolean was
  // sent but that consent was actually given, so `false` must fail validation.
  @Equals(true, {
    message: 'consentAcknowledged must be true to enrol biometric data.',
  })
  consentAcknowledged: boolean;
}

/** The caller's latest re-enrolment request, as the status response carries it. */
export class ReEnrolmentStateDto {
  @ApiProperty() id: string;

  @ApiProperty({
    enum: ['pending', 'approved', 'rejected', 'completed', 'expired'],
  })
  status: string;

  @ApiProperty() reason: string;

  @ApiProperty({ nullable: true, type: String })
  adminRemarks: string | null;

  @ApiProperty() requestedAt: string;

  @ApiProperty({ nullable: true, type: String })
  decidedAt: string | null;

  @ApiProperty({ nullable: true, type: String })
  unlockExpiresAt: string | null;

  @ApiProperty({
    description:
      'Approved, unexpired, and unconsumed — the same three conditions the completion endpoint checks, so the button and the endpoint agree.',
  })
  unlockActive: boolean;
}

/** The enrolment status shape both GET and POST return (contract). */
export class FaceEnrolmentStatusDto {
  @ApiProperty({ enum: ['not_enrolled', 'enrolled', 're_enrolment_requested'] })
  status: string;

  @ApiProperty({ nullable: true, type: String })
  enrolledAt: string | null;

  @ApiProperty({
    nullable: true,
    type: ReEnrolmentStateDto,
    description:
      "The caller's latest re-enrolment request, or null. Lets the client distinguish awaiting-decision from refused from approved-and-still-open, which `status` alone cannot express.",
  })
  reEnrolment: ReEnrolmentStateDto | null;
}
