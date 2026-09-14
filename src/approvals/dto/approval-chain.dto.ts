import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** One level of a chain, as the settings screen submits it (016 FR-001, T046). */
export class ApprovalLevelDto {
  @ApiProperty({
    minimum: 1,
    description:
      'Order in the chain, 1-based. Positions must be contiguous — the service refuses ' +
      'a chain with a hole, because an item reaching the gap would stop with no error ' +
      'raised anywhere.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  position: number;

  @ApiProperty({
    description:
      'Which slot decides at this level — `first_approver`, `hr`, `final`. A slot, not ' +
      'a role: the role it resolves to is per-company and is bound separately through ' +
      '`PUT /approvals/slot-mappings` (FR-001a).',
  })
  @IsString()
  @MaxLength(64)
  slotKey: string;

  @ApiPropertyOptional({
    description:
      'Whether this level is the final authority (FR-018). At most one per chain.',
  })
  @IsOptional()
  @IsBoolean()
  isFinalAuthority?: boolean;

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Overrides the slot’s standard label on this chain only. Omit to use the ' +
      'standard one, which is what keeps the same level reading the same way across ' +
      'modules.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;
}

/**
 * A chain definition, submitted whole (016 FR-001, T046).
 *
 * Levels are replaced wholesale rather than patched one at a time, which is why they are
 * a required array here and not an optional partial. Reconciling individual level edits
 * into a valid contiguous ordering is exactly the kind of arithmetic that is wrong once
 * and then wrong forever; sending the whole chain makes the ordering correct by
 * construction.
 */
export class UpsertApprovalChainDto {
  @ApiProperty({
    description:
      'What kind of decision this chain governs — `attendance_exception`, ' +
      '`payroll_run`. One active chain per action type per company.',
  })
  @IsString()
  @MaxLength(64)
  actionType: string;

  @ApiPropertyOptional({
    description:
      'Whether items on this chain are held until the final authority approves ' +
      '(FR-018).',
  })
  @IsOptional()
  @IsBoolean()
  isFinalAuthorityRequired?: boolean;

  @ApiProperty({
    type: [ApprovalLevelDto],
    description: 'The levels, in order. At least one.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ApprovalLevelDto)
  levels: ApprovalLevelDto[];
}

/**
 * Binding one slot to one role for a company (016 FR-001a, FR-021b, T046).
 *
 * One slot per call rather than a whole map, so the unsatisfiable-chain guard has an
 * unambiguous thing to refuse. A bulk write would have to either apply partially — a
 * settings save that half-succeeds — or report which member of the batch was the problem,
 * which is the same single-slot message with extra steps.
 */
export class PutSlotMappingDto {
  @ApiProperty({ description: '`first_approver`, `hr` or `final`.' })
  @IsString()
  @MaxLength(64)
  slotKey: string;

  @ApiProperty({
    description:
      'The role whose holders decide at every level bound to this slot.',
  })
  @IsString()
  roleId: string;
}
