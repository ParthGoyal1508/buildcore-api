import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
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

/**
 * A face capture in place of the password (054). Since 057 a liveness capture: the photos are the
 * multipart `frames`, in the step order of the challenge named here.
 */
class FaceUnlockCaptureDto extends FaceUnlockPurposeDto {
  @ApiProperty({
    description:
      'The liveness challenge the capture followed: flow `unlock-confirm` (one frame facing the ' +
      'camera, then both head turns) or `unlock-enrolment` (two facing, then both turns).',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  challengeId: string;
}

/** Matching a live face against the caller's registered one. */
export class ConfirmFaceDto extends FaceUnlockCaptureDto {}

/** Registering (or replacing) the caller's own face from a guided capture. */
export class EnrolFaceUnlockDto extends FaceUnlockCaptureDto {}

export class FaceUnlockStatusDto {
  @ApiProperty() enrolled: boolean;
  @ApiProperty({ nullable: true, type: String }) enrolledAt: string | null;
}
