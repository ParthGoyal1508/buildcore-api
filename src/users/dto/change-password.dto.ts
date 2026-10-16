import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { IsNewPassword, PASSWORD_MAX_LENGTH } from '../../auth/password-policy';

export class ChangePasswordDto {
  // No complexity rule on the current password: it is checked against the stored hash, and an
  // account whose password predates the rule must still be able to prove it and move off it.
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  oldPassword: string;

  @ApiProperty({
    description:
      'At least 8 characters, including an uppercase letter and a number (029 FR-005).',
  })
  @IsNewPassword()
  newPassword: string;
}
