import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DwrPaymentMode, DwrWeather } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Creating a day's work report, and the **two shapes** a measurement line can take (022 FR-001,
 * FR-005, FR-030, FR-030b).
 *
 * ## Why one line DTO carries both shapes rather than two endpoints
 *
 * A single day's report mixes them. The client's real package claims seventeen lines in one bill
 * period: some measured (plantation counts, miscellaneous repairs) and most paid for presence (an
 * ambulance, a patrolling vehicle, a crane, forty security guards). Splitting the request would
 * make a supervisor file two reports for one day, and the day is the unit the site works in.
 *
 * So one array, and `paymentMode` decides which fields are permitted on each element. The
 * validation is written to **refuse** the wrong fields rather than ignore them (FR-030b):
 *
 * - a `day_basis` line carrying any of the six factors is refused, because the factors all default
 *   to 1 and their product is 1 — indistinguishable from one day served, so a line that carried
 *   them would be right by coincidence and wrong the moment one changed;
 * - a `work_basis` line carrying a served quantity is refused, for the mirror reason.
 *
 * Both refusals are also enforced by the `DWRTask_quantity_matches_basis` constraint in the
 * database, because a DTO protects one path and a constraint protects all of them.
 *
 * ## The quantity is not an input
 *
 * Neither shape accepts a computed quantity. A `work_basis` line's quantity is the product of its
 * factors, computed on the server (FR-003), and a client-supplied figure is not merely overridden —
 * there is nowhere to put it. That is the difference between ignoring a value and not having a
 * field for it: the first requires a test to prove, the second cannot happen.
 */

const DECIMAL = {
  message: 'Must be a decimal number sent as a string or number.',
};

/** A line whose quantity is measured, from the six dimensions. */
export class CreateDwrWorkLineDto {
  @ApiProperty({ enum: [DwrPaymentMode.work_basis] })
  @IsEnum(DwrPaymentMode)
  paymentMode!: typeof DwrPaymentMode.work_basis;

  /** Nullable: freeform work the BOQ itemises differently is ordinary (FR-007). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  boqItemId?: string;

  // ── The six factors. Omitted means 1; 0 is refused by name (FR-004). ──────
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString({}, DECIMAL)
  nos1?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString({}, DECIMAL)
  nos2?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString({}, DECIMAL)
  length?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString({}, DECIMAL)
  breadth?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString({}, DECIMAL)
  depth?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString({}, DECIMAL)
  density?: string;

  // ── Position (FR-005). Where on the site this measurement was taken. ─────
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString({}, DECIMAL)
  chainageFrom?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString({}, DECIMAL)
  chainageTo?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  layer?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  roadSide?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  section?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  layerNo?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  engineerName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  remark?: string;
}

/** A line paid for presence. Carries no factors — see this file's docblock. */
export class CreateDwrPresenceLineDto {
  @ApiProperty({ enum: [DwrPaymentMode.day_basis] })
  @IsEnum(DwrPaymentMode)
  paymentMode!: typeof DwrPaymentMode.day_basis;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  boqItemId?: string;

  /**
   * The day served: `1` is one full day (FR-030e), less for a part day, `0` for present and
   * performing nothing (FR-031). A value below 1 requires `remark` (FR-030c).
   */
  @ApiProperty({ example: '0.700' })
  @IsNumberString({}, DECIMAL)
  servedQty!: string;

  /** `plant.Equipment.id` — the key its logbook entry for this date is read by (FR-032). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  equipmentId?: string;

  // ── Position (FR-005). ───────────────────────────────────────────────────
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString({}, DECIMAL)
  chainageFrom?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString({}, DECIMAL)
  chainageTo?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  layer?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  roadSide?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  section?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  layerNo?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  engineerName?: string;
  /** Required when `servedQty` is below a full day (FR-030c). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  remark?: string;
}

/**
 * One element of the `lines` array.
 *
 * `class-validator` cannot discriminate a union by a property value, so the union is accepted as
 * the **superset** here and narrowed by `DwrService` through `narrowLine`, which refuses the
 * forbidden combinations by name. The alternative — two arrays, `workLines` and `presenceLines` —
 * was rejected because it changes the request shape to work around a validator limitation, and the
 * order lines were entered in is the order a measurement book reads.
 */
export class CreateDwrLineDto {
  @ApiProperty({ enum: DwrPaymentMode })
  @IsEnum(DwrPaymentMode)
  paymentMode!: DwrPaymentMode;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  boqItemId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString({}, DECIMAL)
  nos1?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString({}, DECIMAL)
  nos2?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString({}, DECIMAL)
  length?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString({}, DECIMAL)
  breadth?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString({}, DECIMAL)
  depth?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString({}, DECIMAL)
  density?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString({}, DECIMAL)
  servedQty?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  equipmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString({}, DECIMAL)
  chainageFrom?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString({}, DECIMAL)
  chainageTo?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  layer?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  roadSide?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  section?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  layerNo?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  engineerName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  remark?: string;
}

/** The maximum lines one day's report may carry. The client's real bill claims 17. */
export const MAX_DWR_LINES = 500;

export class CreateDwrDto {
  @ApiProperty({
    example: '2026-01-15',
    description: 'The day being reported.',
  })
  @IsDateString()
  workDate!: string;

  /** `hr.Employee.id`, held bare — Principle I forbids the cross-schema relation. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  supervisorEmployeeId?: string;

  @ApiPropertyOptional({ enum: DwrWeather })
  @IsOptional()
  @IsEnum(DwrWeather)
  weather?: DwrWeather;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  workerCount?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  machineryCount?: number;

  /**
   * The supervisor's own 0–100 assessment, reported **beside** the quantity-derived progress the
   * BOQ computes rather than reconciled with it — the schema note says so, and the two measure
   * different things: one is a judgement about the site, the other is arithmetic about scope.
   */
  @ApiPropertyOptional({ default: 0, minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  progress?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  location?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contractFor?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contractNumber?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  rfiNo?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  layer?: string;

  /** Empty is permitted on a draft and refused at submission (FR-024). */
  @ApiPropertyOptional({ type: [CreateDwrLineDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_DWR_LINES)
  @ValidateNested({ each: true })
  @Type(() => CreateDwrLineDto)
  lines?: CreateDwrLineDto[];

  /**
   * Accept the report even though its work date precedes the project's start date (FR-025).
   *
   * Absent, the discrepancy comes back as a warning on a successful create — it is not a refusal,
   * because a start date corrected after the fact is far more common than invented work.
   */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  acknowledgeDateBeforeProjectStart?: boolean;
}
