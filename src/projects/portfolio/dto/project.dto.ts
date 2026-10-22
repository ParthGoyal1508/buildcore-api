import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  ProjectDivision,
  ProjectSiteType,
  ProjectStatus,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * A new project (spec US3).
 *
 * There is no `code` (2026-10-15). Every project is numbered from the company's
 * PROJECTS series — `1010`, `1020`, `1030` — and the client asked for that to be
 * enforced: a code cannot be typed on creation, nor changed afterwards, so the series
 * is the only source of one. A request that still sends `code` is refused (the global
 * pipe forbids undeclared fields) rather than having it quietly ignored.
 */
export class CreateProjectDto {
  /**
   * Documents staged for this project, by `stagedDocumentId` (017 FR-009, FR-009a).
   *
   * **Creation is refused while any mandatory kind has no document among these** — the client's
   * "Project Managers cannot create a project without them". The refusal names every missing kind
   * and creates nothing.
   *
   * Each reference may be used by the person who staged it and only once. A reference belonging to
   * somebody else is refused with the same code as a nonexistent one, so the refusal cannot be used
   * to discover another user's staged document.
   */
  @ApiPropertyOptional({
    isArray: true,
    type: String,
    description:
      'Staged document ids, from POST /projects/document-uploads. Creation is refused while a ' +
      'mandatory kind has none.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  stagedDocumentIds?: string[];

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  clientId!: string;

  /** The company branch (GST registration) the project bills from (041). Omitted → head office. */
  @ApiPropertyOptional({
    description:
      'Company branch the project bills from; defaults to the head office',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  branchId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;

  @ApiProperty({ minimum: 0, description: 'Contract value in INR.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999_999)
  contractValue!: number;

  @ApiProperty({ format: 'date' })
  @IsDateString()
  startDate!: string;

  @ApiPropertyOptional({ format: 'date' })
  @IsOptional()
  @IsDateString()
  expectedEndDate?: string;

  @ApiPropertyOptional({ enum: ProjectStatus, default: ProjectStatus.planning })
  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;

  @ApiPropertyOptional({
    description: '`hr.Employee.id` of the project manager.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  projectManagerEmployeeId?: string;

  @ApiPropertyOptional({
    enum: ProjectDivision,
    default: ProjectDivision.contract,
  })
  @IsOptional()
  @IsEnum(ProjectDivision)
  division?: ProjectDivision;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  departmentType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  projectType?: string;

  @ApiPropertyOptional({
    enum: ProjectSiteType,
    default: ProjectSiteType.site,
  })
  @IsOptional()
  @IsEnum(ProjectSiteType)
  siteType?: ProjectSiteType;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isHO?: boolean;

  @ApiPropertyOptional({ format: 'date' })
  @IsOptional()
  @IsDateString()
  siteStartDate?: string;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999_999)
  purchaseLimit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  orderNumber?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  cgstApplicable?: boolean;

  @ApiPropertyOptional({
    description:
      'The client contract’s retention term, **as a fraction** — `0.05` is 5%. Bounded at 1: a ' +
      'retention of more than the bill makes every net payable zero, which is a typo rather than ' +
      'a term.\n\n' +
      '**A fraction rather than a percentage, deliberately.** `WorkOrder.retentionPercent` is a ' +
      'fraction with the same bound, and the bill composer reads the two terms four lines apart ' +
      'in one function — `resolveRates()` takes this one for a bill to the client and that one ' +
      'for a bill to a subcontractor. Two units in one function is how a 5% term becomes a 500% ' +
      'deduction. A screen collecting a percentage divides by 100 before sending, as the ' +
      'subcontract bill sheet already does.\n\n' +
      '**Absent is not zero.** Composing a client bill without this answers 400 and says why: ' +
      'billing at zero retention makes the payable five per cent too high and nothing downstream ' +
      'would notice. Until 025 this column was settable nowhere, so that refusal was unanswerable ' +
      'and the client half of the running-account package could not be used at all.',
    minimum: 0,
    maximum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(1)
  clientRetentionFraction?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5_000)
  description?: string;
}

/**
 * Every create field, all optional, plus the lock switch.
 *
 * `isLocked` is deliberately absent from create — a project nobody has entered data
 * into yet has nothing to protect, and allowing it would let someone create a
 * project that cannot be worked on.
 */
export class UpdateProjectDto extends PartialType(CreateProjectDto) {
  @ApiPropertyOptional({
    description:
      'Freezes every data-entry endpoint on this project; writes then return 423. ' +
      'The transition is audit-logged.',
  })
  @IsOptional()
  @IsBoolean()
  isLocked?: boolean;
}

/**
 * Query parameters for the portfolio list. A DTO class rather than loose `@Query()`
 * parameters — see `ListClientsDto` for why.
 */
export class ListProjectsDto {
  @ApiPropertyOptional({ description: 'Matches project name or code' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({
    enum: ProjectStatus,
    description: 'Omit to see every status',
  })
  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  clientId?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  page?: number;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  pageSize?: number;

  @ApiPropertyOptional({ description: 'Cross-company callers only' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;

  @ApiPropertyOptional({
    description:
      'Comma-separated extras. `documentReadiness` attaches each project’s document ' +
      'readiness to the row (017 FR-008), so the portfolio shows what a project still ' +
      'owes without opening it. Opt-in because it costs two extra queries and the ' +
      'screens that do not show it should not pay for them.',
    example: 'documentReadiness',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  include?: string;
}
