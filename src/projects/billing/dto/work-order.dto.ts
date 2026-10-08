import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { WorkOrderStatus } from '@prisma/client';

export class CreateWorkOrderDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  projectId: string;

  @ApiPropertyOptional({
    description:
      '`partners.Vendor.id`. Stored as given and **not validated** — see the service comment: ' +
      '`PartnersModule` imports `ProjectsModule`, so checking it here would close a module cycle.',
  })
  @IsOptional()
  @IsString()
  partnerId?: string;

  @ApiProperty({ example: 'RCC works — blocks A to C' })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  workDetail: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  terms?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  requirements?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  hireContract?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  labourAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  materialAmount?: number;

  @ApiPropertyOptional({
    description:
      'Retention withheld per RA bill, as a fraction — `0.05` is 5%. Bounded at 1: a retention of ' +
      'more than the bill would make every net payable zero, which is a typo rather than a term.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(1)
  retentionPercent?: number;

  // **`status` was accepted here and is deliberately gone** (028 FR-009).
  //
  // A new work order is a `draft`, always. Accepting a status let a caller declare an award
  // `active` on creation and bill against it immediately — which is the whole of what the approval
  // this feature added was for, walked around by the one screen that raises an award. A control
  // enforced by a form over an endpoint that accepts anything is a control in appearance only, and
  // this feature's own spec says so about the purchase rate.
  //
  // `pending_approval` comes from `POST /projects/work-orders/:id/submit`; `active` comes from the
  // approval chain completing and from nowhere else.
}

export class UpdateWorkOrderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  partnerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  workDetail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  terms?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  requirements?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  hireContract?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  labourAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  materialAmount?: number;

  @ApiPropertyOptional({
    description:
      'Refused once a bill has been raised — `WORK_ORDER_RETENTION_LOCKED`.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(1)
  retentionPercent?: number;

  /**
   * The only status an edit may set is `completed` (028 FR-009).
   *
   * Closing out a finished award is an ordinary edit. The other three are not: `pending_approval`
   * is reached by submitting, `active` by the chain completing, and reverting an active award to
   * `draft` would strip an approval that has already been given — so each is refused by name in
   * the service rather than silently ignored here.
   */
  @ApiPropertyOptional({ enum: WorkOrderStatus })
  @IsOptional()
  @IsEnum(WorkOrderStatus)
  status?: WorkOrderStatus;
}

/**
 * Reopening an approved award (2026-10-08).
 *
 * The reason is required because the act removes a control: an approval given on a set of figures
 * stops applying, and "why" is the only part of that a reader can act on afterwards. Same floor as
 * every other reason in this product — a one-word answer tells the next person nothing.
 */
export class ReopenAwardDto {
  @ApiProperty({
    example: 'rate on line 3 captured as 5,185 — the signed award says 4,185',
    minLength: 10,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(10, {
    message:
      'Say what has to change. Reopening voids an approval somebody gave, and the record of why ' +
      'is the only thing that explains it later.',
  })
  @MaxLength(2000)
  reason!: string;
}
