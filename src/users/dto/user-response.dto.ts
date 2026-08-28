import { ApiProperty } from '@nestjs/swagger';
import { Permission } from '@prisma/client';
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
    };
  }
}
