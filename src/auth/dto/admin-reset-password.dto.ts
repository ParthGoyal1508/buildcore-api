import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsNewPassword } from '../password-policy';

export const ADMIN_RESET_METHODS = ['link', 'temporary_password'] as const;
export type AdminResetMethod = (typeof ADMIN_RESET_METHODS)[number];

export class AdminResetPasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  targetAccountId: string;

  /**
   * How the account gets back in (029 FR-014).
   *
   * `link` — the recommended one — emails the holder a single-use link to choose their own
   * password; the admin never knows it, and the current password keeps working until the link
   * is used. `temporary_password` sets one now, signs the account out everywhere and forces a
   * change at the next sign-in; it is for someone who cannot reach their inbox.
   *
   * Omitted: `temporary_password` when `temporaryPassword` is sent (the pre-029 request shape),
   * `link` otherwise.
   */
  @ApiPropertyOptional({ enum: ADMIN_RESET_METHODS })
  @IsOptional()
  @IsIn(ADMIN_RESET_METHODS)
  method?: AdminResetMethod;

  /**
   * Only with `temporary_password`, and optional there: left out, the server generates one and
   * returns it once. Generating is the better default — a password an admin makes up on the spot
   * is the one most likely to be guessed, or reused for the next person.
   */
  @ApiPropertyOptional({
    description:
      'At least 8 characters with an uppercase letter and a number. Omit to have one generated.',
  })
  @IsOptional()
  @IsNewPassword()
  temporaryPassword?: string;
}

export class AdminResetPasswordResultDto {
  @ApiProperty({ enum: ADMIN_RESET_METHODS })
  method: AdminResetMethod;

  @ApiPropertyOptional({
    description:
      'The temporary password, when the server generated it. Returned this once and never stored in clear.',
  })
  temporaryPassword?: string;

  @ApiProperty({
    description:
      'The reset happened but its email could not be sent — for `link`, resend it.',
  })
  emailDispatchFailed: boolean;
}
