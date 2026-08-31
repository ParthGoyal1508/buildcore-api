import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * The invite form's payload.
 *
 * Deliberately has no `username` and no `password`. The username is generated
 * server-side from the email (data-model.md, resolved 2026-08-30), and the password
 * is chosen by the invitee — the whole point of an invite flow is that the admin
 * never handles either.
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
}
