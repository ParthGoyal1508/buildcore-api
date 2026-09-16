import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * A company-defined letter kind (017 FR-011).
 *
 * The point of this DTO is that defining a new kind is a **data** operation. Before 017
 * it was a Prisma enum value, which meant a migration and a release; FR-011 says a new
 * kind must not need a code change, and a row is what makes that true.
 */
export class CreateLetterKindDto {
  @ApiProperty({
    description:
      'Stable identifier, lowercase with underscores. Not editable afterwards — the ' +
      'label is what changes when somebody wants different words.',
    example: 'site_transfer',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message:
      'key must be lowercase letters, digits and underscores, starting with a letter',
  })
  key: string;

  @ApiProperty({ description: 'What a person sees.', example: 'Site transfer' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  requiresSignature?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      'When true, `approvalActionType` must name a 016 action type with a configured ' +
      'chain. Issue is refused until that chain completes (FR-015a).',
  })
  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;

  @ApiPropertyOptional({
    description: 'The 016 action type to gate on, e.g. `letter_work_order`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  approvalActionType?: string;
}

/** Everything except `key`, which is the one thing that may not change. */
export class UpdateLetterKindDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiresSignature?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  approvalActionType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
