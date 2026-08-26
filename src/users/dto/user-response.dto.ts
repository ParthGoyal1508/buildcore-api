import { ApiProperty } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';

export class UserResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty()
  email: string;

  @ApiProperty({ required: false })
  firstname?: string | null;

  @ApiProperty({ required: false })
  lastname?: string | null;

  @ApiProperty({ enum: Role })
  role: Role;

  // Deliberately omits `password` — this is the boundary that keeps the
  // hash out of every API response, since Prisma's User type carries it.
  static fromEntity(user: User): UserResponseDto {
    const { id, createdAt, updatedAt, email, firstname, lastname, role } = user;
    return { id, createdAt, updatedAt, email, firstname, lastname, role };
  }
}
