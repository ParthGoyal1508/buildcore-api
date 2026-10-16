import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PASSWORD_MAX_LENGTH } from '../password-policy';

export class LoginDto {
  @ApiProperty({ description: "The account's email or username" })
  @IsString()
  @IsNotEmpty()
  identifier: string;

  @ApiProperty()
  @IsNotEmpty()
  @MinLength(8)
  // The ceiling, and not the complexity rule: an account whose password predates the rule must
  // still be able to sign in (029 FR-005).
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;

  /**
   * Accepted and ignored (015 FR-003).
   *
   * Every session now lasts the same 90 days, so there is nothing for this to select.
   * It is kept rather than deleted because `forbidNonWhitelisted` is enabled globally
   * and the two services deploy independently: removing it would make this API reject
   * every request from the currently-deployed frontend the moment it shipped.
   *
   * @deprecated Has no effect. Remove once no deployed client sends it.
   */
  @ApiPropertyOptional({
    deprecated: true,
    description: 'Ignored. Every session lasts the same length.',
  })
  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}
