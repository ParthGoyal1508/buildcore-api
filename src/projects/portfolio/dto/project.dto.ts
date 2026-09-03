import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  ProjectDivision,
  ProjectSiteType,
  ProjectStatus,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * A new project (spec US3).
 *
 * `code` is optional: omit it and one is allocated from the company's PROJECTS
 * series. Supplying it is allowed because migrated projects arrive with codes their
 * paperwork already refers to, and forcing those to be renumbered would break every
 * external reference to them.
 */
export class CreateProjectDto {
  @ApiPropertyOptional({
    description:
      'Omit to allocate the next code in the company PROJECTS series (e.g. ACME-PRJ-0001).',
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  code?: string;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  clientId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  location?: string;

  @ApiProperty({ minimum: 0, description: 'Contract value in INR.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
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
  departmentType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
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
  purchaseLimit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  orderNumber?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  cgstApplicable?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
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
  clientId?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;

  @ApiPropertyOptional({ description: 'Cross-company callers only' })
  @IsOptional()
  @IsString()
  companyId?: string;
}
