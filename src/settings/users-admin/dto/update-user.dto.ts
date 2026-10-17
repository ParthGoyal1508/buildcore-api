import { ApiPropertyOptional } from '@nestjs/swagger';
import { UserStatus } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class UpdateUserAccountDto {
  /**
   * Singular by contract — the Users form offered one Role dropdown. Under the
   * many-to-many `UserRole` model this replaces whatever roles the account holds
   * with just this one.
   *
   * Kept for older clients. `roleIds` is what the Users screen sends since 036 C1: a form that
   * edited only `roles[0]` silently removed every other role of a multi-role account on Save.
   */
  @ApiPropertyOptional({
    description:
      "Replaces the account's role assignment with this one role. Prefer `roleIds`.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  roleId?: string;

  /**
   * The account's complete set of roles after the save (036 C1, decision 8: multi-select).
   *
   * The server works out what that adds and removes against what the account holds now, and
   * checks and audits each side explicitly: an added role must be within what the caller may grant,
   * and removing the last protected role from the last Super Admin is refused. A role already held
   * and still listed is untouched — it is not re-checked against the caller's ceiling, so an
   * administrator can add a role to an account that also holds one wider than their own.
   *
   * At least one (036 C2): the old form offered "— No role —", which sent nothing and reported
   * success while changing nothing. An account with no role can sign in to nothing; deactivate it.
   */
  @ApiPropertyOptional({
    type: [String],
    description:
      "The account's full role set after the save. Takes precedence over `roleId`.",
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'Choose at least one role' })
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  roleIds?: string[];

  @ApiPropertyOptional({ enum: UserStatus })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;
}
