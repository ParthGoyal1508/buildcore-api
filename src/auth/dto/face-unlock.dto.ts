import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsString,
} from 'class-validator';

import { IsBase64Payload } from '../../common/uploads/base64-payload';
import {
  CONFIRMATION_PURPOSES,
  ConfirmationPurpose,
} from '../password-confirmation.service';

const purposeProperty = {
  enum: Object.keys(CONFIRMATION_PURPOSES),
  description: 'The sensitive act the face confirms, as for confirm-password.',
};

export class FaceUnlockPurposeDto {
  @ApiProperty(purposeProperty)
  @IsIn(Object.keys(CONFIRMATION_PURPOSES))
  purpose: ConfirmationPurpose;
}

/** One live camera frame, matched against the caller's registered face (054). */
export class ConfirmFaceDto extends FaceUnlockPurposeDto {
  @ApiProperty({
    description: 'Base64 JPEG/PNG/WebP (data-URL prefix optional)',
  })
  @IsString()
  @IsBase64Payload()
  photo: string;
}

/** Registering (or replacing) the caller's own face: 3–5 frames, averaged into one descriptor. */
export class EnrolFaceUnlockDto extends FaceUnlockPurposeDto {
  @ApiProperty({ type: [String], minItems: 3, maxItems: 5 })
  @IsArray()
  @ArrayMinSize(3, { message: 'At least 3 photos are required.' })
  @ArrayMaxSize(5, { message: 'At most 5 photos may be submitted.' })
  @IsString({ each: true })
  @IsBase64Payload({ each: true })
  photos: string[];
}

export class FaceUnlockStatusDto {
  @ApiProperty() enrolled: boolean;
  @ApiProperty({ nullable: true, type: String }) enrolledAt: string | null;
}
