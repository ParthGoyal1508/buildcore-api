import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { IsNewPassword } from '../password-policy';

/** A reset token is 64 hex characters (32 bytes); anything else is refused before a lookup. */
const RESET_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export class ForgotPasswordDto {
  @ApiProperty({
    description: "The account's email or username, as at sign-in",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  identifier: string;
}

/**
 * The token travels in the body, never the path (029 FR-012): a path ends up in access logs and
 * proxy logs, and a reset token in a log is a working credential in a log.
 */
export class ResetTokenDto {
  @ApiProperty()
  @IsString()
  @Matches(RESET_TOKEN_PATTERN, { message: 'That reset link is not valid.' })
  @MaxLength(500)
  token: string;
}

export class ResetPasswordDto extends ResetTokenDto {
  @ApiProperty({
    description:
      'At least 8 characters, including an uppercase letter and a number.',
  })
  @IsNewPassword()
  password: string;
}
