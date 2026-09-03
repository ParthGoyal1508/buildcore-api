import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClientStatus } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { GSTIN_REGEX } from '../../../settings/companies/dto/create-company.dto';

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

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail({}, { message: 'email is not a valid email address' })
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({
    description:
      '15-character GSTIN. Unique per company when present; omitting it is allowed ' +
      'and does not collide with other GSTIN-less clients.',
  })
  @IsOptional()
  @Matches(GSTIN_REGEX, { message: 'gstin is not a valid GSTIN' })
  gstin?: string;

  @ApiPropertyOptional({ enum: ClientStatus, default: ClientStatus.active })
  @IsOptional()
  @IsEnum(ClientStatus)
  status?: ClientStatus;
}
