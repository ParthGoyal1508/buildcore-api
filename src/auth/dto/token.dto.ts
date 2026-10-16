import { ApiProperty } from '@nestjs/swagger';
import { HOME_MODULES, HomeModule } from '../../settings/roles/home-modules';

/** The refresh token is never in this body — cookie-only delivery (FR-006). */
export class TokenDto {
  @ApiProperty({ description: 'JWT access token' })
  accessToken: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  mustChangePassword: boolean;

  /** Where to land (029 FR-021) — carried here so the client need not ask before routing,
   * which on a site's mobile connection is a second round trip before anything shows. */
  @ApiProperty({ enum: HOME_MODULES, nullable: true })
  homeModule: HomeModule | null;
}
