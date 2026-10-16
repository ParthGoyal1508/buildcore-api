import { ApiProperty } from '@nestjs/swagger';
import { IsNewPassword } from '../../../auth/password-policy';

export class SetPasswordDto {
  @ApiProperty({
    description:
      'At least 8 characters, including an uppercase letter and a number.',
  })
  @IsNewPassword()
  password: string;
}
