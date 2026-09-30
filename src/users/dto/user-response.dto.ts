import { ApiProperty } from '@nestjs/swagger';
import { AccessLevel, Permission } from '@prisma/client';
import { AuthenticatedUser } from '../../auth/authenticated-user';

export class UserResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty()
  email: string;

  @ApiProperty()
  username: string;

  @ApiProperty({ required: false })
  firstname?: string | null;

  @ApiProperty({ required: false })
  lastname?: string | null;

  @ApiProperty({ type: [String] })
  roleNames: string[];

  @ApiProperty({ enum: Permission, isArray: true })
  permissions: Permission[];

  /**
   * The same areas, each with the level it is held at (019 FR-001).
   *
   * **Additive, not a replacement.** `permissions` above keeps its meaning — the areas
   * held at some level — so a client reading it as a flat list of strings is unaffected.
   * That is deliberate: a breaking shape change here would break every screen at once,
   * and the level is only needed by the parts of an interface that decide whether to
   * render a control (FR-004).
   */
  @ApiProperty({
    isArray: true,
    description: 'Area and level pairs. Additive; `permissions` is unchanged.',
  })
  grants: { permission: Permission; level: AccessLevel }[];

  // Deliberately omits `password` — this is the boundary that keeps the
  // hash out of every API response, since Prisma's User type carries it.
  static fromEntity(user: AuthenticatedUser): UserResponseDto {
    const {
      id,
      createdAt,
      updatedAt,
      email,
      username,
      firstname,
      lastname,
      roleNames,
      permissions,
      grants,
    } = user;
    return {
      id,
      createdAt,
      updatedAt,
      email,
      username,
      firstname,
      lastname,
      roleNames,
      permissions,
      grants: grants ?? [],
    };
  }
}
