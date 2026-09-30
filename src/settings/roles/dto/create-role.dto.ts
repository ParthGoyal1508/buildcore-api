import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccessLevel, Permission } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

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

  /**
   * The level each area is granted at (019 FR-001, FR-002).
   *
   * **Optional, and absent means read + write** — which is what holding a permission has
   * always meant, and what the Phase 1 backfill gave every existing role. An administrator
   * who names no levels gets today's behaviour, so no existing caller of this endpoint
   * changes meaning.
   *
   * Every area named here must also appear in `permissions`: that list stays the set of areas
   * the role touches, so every `permissions.includes(...)` in the codebase keeps working while
   * `Role.permissions` is on its way out.
   */
  @ApiPropertyOptional({
    isArray: true,
    description:
      'Per-area levels. Omit for read+write on everything in `permissions`, which is ' +
      'what holding a permission has always meant.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoleGrantDto)
  grants?: RoleGrantDto[];
}

/** One area at one level. */
export class RoleGrantDto {
  @ApiProperty({ enum: ASSIGNABLE_PERMISSIONS })
  @IsIn(ASSIGNABLE_PERMISSIONS)
  permission: Permission;

  @ApiProperty({ enum: AccessLevel })
  @IsEnum(AccessLevel)
  level: AccessLevel;
}
