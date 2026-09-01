import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  PASSWORD_COMPLEXITY,
  PASSWORD_COMPLEXITY_MESSAGE,
} from '../../constants/account-creation.constants';

/**
 * The invite form's payload.
 *
 * Deliberately has no `username`: it is generated server-side from the email
 * (data-model.md, resolved 2026-08-30).
 *
 * `password` is optional and switches the creation mode (FR-015). Absent — the
 * invite flow, where the invitee chooses their own and the admin never handles it.
 * Present — the admin sets it directly, the account opens immediately, and it must
 * be changed at first login (FR-017), because the admin necessarily knows it.
 *
 * Two rules cannot be expressed with decorators and are enforced in `UsersService`:
 * `companyId` is required unless the chosen role carries cross-company access, and
 * exactly one of `employeeId` / `displayName` must be present. Both need the role
 * looked up first, which a validator cannot do.
 */
export class CreateUserDto {
  @ApiProperty({ example: 'site.engineer@example.com' })
  @IsEmail({}, { message: 'A valid email address is required.' })
  email: string;

  @ApiProperty({ description: 'The role to assign (settings.Role id).' })
  @IsString()
  @MinLength(1)
  roleId: string;

  @ApiPropertyOptional({
    description:
      'Required unless the chosen role carries cross-company access, and rejected when it does.',
  })
  @IsOptional()
  @IsString()
  companyId?: string;

  @ApiPropertyOptional({
    description:
      'Links an existing hr.Employee to the new account. Mutually exclusive with displayName.',
  })
  @IsOptional()
  @IsString()
  employeeId?: string;

  @ApiPropertyOptional({
    description:
      'Name to show when no employee is linked. Mutually exclusive with employeeId.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName?: string;

  @ApiPropertyOptional({
    description:
      'Sets the account up directly with this password instead of sending an invite (FR-015). The account is created active and must change it at first login. Omit for the normal invite flow.',
  })
  @IsOptional()
  @IsString()
  // The invitee's own rule, reused rather than restated — the two paths must not
  // be able to drift apart on what counts as an acceptable password (FR-016).
  @Matches(PASSWORD_COMPLEXITY, { message: PASSWORD_COMPLEXITY_MESSAGE })
  password?: string;
}