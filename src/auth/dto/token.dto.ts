import { ApiProperty } from '@nestjs/swagger';

/** The refresh token is never in this body — cookie-only delivery (FR-006). */
export class TokenDto {
  @ApiProperty({ description: 'JWT access token' })
  accessToken: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  mustChangePassword: boolean;
}
