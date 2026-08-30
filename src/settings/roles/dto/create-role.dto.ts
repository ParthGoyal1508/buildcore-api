import { ApiProperty } from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import { ArrayUnique, IsIn, IsNotEmpty, IsString } from 'class-validator';

/**
 * The permissions a role-management request may set (FR-007).
 *
 * Every `Permission` value except `CROSS_COMPANY_ACCESS`, which grants visibility
 * across every company and is carried only by the protected Super Admin role. It
 * stays in the enum and stays grantable by seeding, but it is deliberately not an
 * ordinary editable checkbox — so an admin cannot mint a second cross-company role
 * through the Roles screen.
 */
export const ASSIGNABLE_PERMISSIONS: Permission[] = Object.values(
  Permission,
).filter((p) => p !== Permission.CROSS_COMPANY_ACCESS);

export class CreateRoleDto {
  @ApiProperty({ description: 'Unique across roles' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    enum: ASSIGNABLE_PERMISSIONS,
    isArray: true,
    description:
      'Values outside the enum are rejected (FR-007); CROSS_COMPANY_ACCESS is not assignable here',
  })
  @ArrayUnique()
  @IsIn(ASSIGNABLE_PERMISSIONS, {
    each: true,
    message: `each permission must be one of: ${ASSIGNABLE_PERMISSIONS.join(
      ', ',
    )}`,
  })
  permissions: Permission[];
}
