import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';
import {
  PASSWORD_COMPLEXITY,
  PASSWORD_COMPLEXITY_MESSAGE,
} from '../../constants/account-creation.constants';

export class SetPasswordDto {
  @ApiProperty({
    description:
      'At least 8 characters, including an uppercase letter and a number.',
  })
  @Matches(PASSWORD_COMPLEXITY, { message: PASSWORD_COMPLEXITY_MESSAGE })
  password: string;
}
