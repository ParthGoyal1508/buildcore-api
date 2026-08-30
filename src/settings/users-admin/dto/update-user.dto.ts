import { ApiPropertyOptional } from '@nestjs/swagger';
import { UserStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class UpdateUserAccountDto {
  /**
   * Singular by contract — the Users form offers one Role dropdown. Under the
   * many-to-many `UserRole` model this replaces whatever roles the account holds
   * with just this one.
   */
  @ApiPropertyOptional({
    description: "Replaces the account's role assignment",
  })
  @IsOptional()
  @IsString()
  roleId?: string;

  @ApiPropertyOptional({ enum: UserStatus })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;
}
