import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString } from 'class-validator';

import {
  CONFIRMATION_PURPOSES,
  ConfirmationPurpose,
} from '../password-confirmation.service';

/** Re-entering one's own password before a sensitive act (2026-10-14). */
export class ConfirmPasswordDto {
  @ApiProperty({ description: "The caller's own current password" })
  @IsString()
  @IsNotEmpty()
  password: string;

  @ApiProperty({
    enum: Object.keys(CONFIRMATION_PURPOSES),
    description:
      'What the confirmation will be spent on. The token is only accepted for this purpose.',
  })
  @IsIn(Object.keys(CONFIRMATION_PURPOSES))
  purpose: ConfirmationPurpose;
}

export class ConfirmPasswordResultDto {
  @ApiProperty({
    description: `Send as the \`X-Confirmation-Token\` header on the confirmed request.`,
  })
  confirmationToken: string;

  @ApiProperty({
    description: 'When the confirmation stops being accepted (ISO 8601)',
  })
  expiresAt: string;
}
