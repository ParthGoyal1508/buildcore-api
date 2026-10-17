import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClientStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

import { GSTIN_REGEX } from '../../../settings/companies/dto/create-company.dto';

/**
 * A blank (`""` or whitespace) read as **null** — "no value" — for the optional fields whose
 * validator a blank can never satisfy (036 I19/I20).
 *
 * The client form sent `email: ""` for a client with no email, and `@IsEmail` refused it, so a
 * client could not be created without one. And clearing a wrong GSTIN, PAN or state had no
 * payload that worked: `undefined` means "unchanged" and `""` fails the format check. Both now
 * work: `null` (what the web sends from Wave 3) and `""` (what older clients still send) clear the
 * field on edit and leave it empty on create.
 */
const blankAsNull = () =>
  Transform(({ value }) =>
    typeof value === 'string' && value.trim() === '' ? null : value,
  );

/**
 * Validates only a value that is actually there: `null` is "clear this field", not a malformed
 * one. `@IsOptional` already skips null, and this says so where the next reader will look.
 */
const unlessNull = () => ValidateIf((_, value) => value !== null);

/**
 * A new client (spec US1).
 *
 * GSTIN reuses the regex 002 already defined for Company and 007 for Vendor rather
 * than declaring a third copy — Principle III, and a GSTIN that is valid on one
 * screen and rejected on another is the exact failure a shared constant prevents.
 */
export class CreateClientDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ maxLength: 150 })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  contactPerson?: string;

  @ApiPropertyOptional({ maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'A blank string is read as no email (036 I20).',
  })
  @blankAsNull()
  @IsOptional()
  @unlessNull()
  @IsEmail({}, { message: 'email is not a valid email address' })
  email?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  address?: string;

  @ApiPropertyOptional({
    description:
      '15-character GSTIN. Unique per company when present; omitting it is allowed ' +
      'and does not collide with other GSTIN-less clients. On edit, `null` (or a blank) ' +
      'clears it (036 I19).',
    nullable: true,
  })
  @blankAsNull()
  @IsOptional()
  @unlessNull()
  @Matches(GSTIN_REGEX, { message: 'gstin is not a valid GSTIN' })
  gstin?: string | null;

  @ApiPropertyOptional({
    description:
      'Permanent account number, as it prints on the bill’s statutory header (025 FR-039). ' +
      'Optional: a bill is **issued** with a blank here and the gap reported, never refused — a ' +
      'document that cannot be produced because a PAN is unrecorded is worse than one produced ' +
      'with a blank somebody fills in by hand.',
    example: 'AABCP1234F',
    nullable: true,
  })
  @blankAsNull()
  @IsOptional()
  @unlessNull()
  @Matches(/^[A-Z]{5}[0-9]{4}[A-Z]$/, {
    message: 'pan is not a valid permanent account number',
  })
  pan?: string | null;

  @ApiPropertyOptional({
    description:
      'Two-digit GST state code — `08` is Rajasthan, and it is the GSTIN’s own first two ' +
      'characters (025 FR-039).\n\n' +
      '**A header field, not the tax decision.** The intra/inter-state basis is derived from the ' +
      'two parties’ GSTINs, whose first two characters *are* the state code — so a client with a ' +
      'GSTIN already decides the tax correctly whether or not this is filled in. This is what ' +
      'prints in the header’s State row, which until now printed blank on every bill.\n\n' +
      'Text, never a number: `08` is not `8`.',
    example: '08',
    nullable: true,
  })
  @blankAsNull()
  @IsOptional()
  @unlessNull()
  @Matches(/^[0-9]{2}$/, {
    message: 'state must be a two-digit GST state code, such as 08',
  })
  state?: string | null;

  @ApiPropertyOptional({ enum: ClientStatus, default: ClientStatus.active })
  @IsOptional()
  @IsEnum(ClientStatus)
  status?: ClientStatus;
}
