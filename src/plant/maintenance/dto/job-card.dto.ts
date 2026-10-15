import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** The tick-box choices printed on the client's job card (2026-10-15), in its order. */
export const JOB_CARD_PRIORITIES = ['Breakdown', 'Urgent', 'Routine'] as const;
export const JOB_CARD_TYPES = [
  'Preventive',
  'Corrective',
  'Inspection',
] as const;
export const JOB_CARD_CONDITIONS = [
  'Running',
  'Not Running',
  'Unsafe to Operate',
] as const;
export const JOB_CARD_CHECKS = [
  'Visual inspection',
  'Fluid / oil levels',
  'Leaks',
  'Brakes / steering',
  'Electrical',
  'Guards / safety devices',
  'Trial run / road test',
] as const;
export const JOB_CARD_RESULTS = [
  'Satisfactory',
  'Further repair required',
  'Not tested',
] as const;
export const JOB_CARD_STATUSES = [
  'Fit for use',
  'Fit with restrictions',
  'Out of service',
] as const;

const text = (max = 200) => [IsOptional(), IsString(), MaxLength(max)];

function Text(max = 200): PropertyDecorator {
  return (target, key) => {
    for (const decorator of text(max)) decorator(target, key);
    ApiPropertyOptional()(target, key);
  };
}

/** Section 3: one inspection / fault and the work done on it. */
export class JobCardInspectionDto {
  @Text(300) fault?: string;
  @Text(300) action?: string;

  @ApiPropertyOptional({ description: 'Technician quotation amount, rupees' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  quotationAmount?: number;

  @Text(20) startTime?: string;
  @Text(20) finishTime?: string;
}

/** Section 4: a spare part or consumable used that was not drawn from the spare-parts store. */
export class JobCardPartDto {
  @Text(200) description?: string;
  @Text(60) partNo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  quantity?: number;

  @Text(20) unit?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  rate?: number;
}

export class JobCardSignOffDto {
  @Text(80) operator?: string;
  @Text(80) technician?: string;
  @Text(80) supervisor?: string;
  @Text(80) incharge?: string;
}

/**
 * The maintenance job card (2026-10-15), every field the client's format prints. Section 1's
 * machine fields are filled from the machine when left out — the client: "when an equipment item
 * is selected, the Job Card and Equipment Details sections should auto-populate".
 */
export class JobCardDto {
  @ApiPropertyOptional({ example: '2026-10-15' })
  @IsOptional()
  @IsISO8601()
  date?: string;

  @ApiPropertyOptional({ enum: JOB_CARD_PRIORITIES })
  @IsOptional()
  @IsIn(JOB_CARD_PRIORITIES)
  priority?: string;

  @ApiPropertyOptional({ enum: JOB_CARD_TYPES })
  @IsOptional()
  @IsIn(JOB_CARD_TYPES)
  jobType?: string;

  @Text(80) department?: string;
  @Text(80) requestedBy?: string;
  @Text(120) location?: string;
  @Text(40) contact?: string;

  // Section 1's machine fields — filled from the machine when left out.
  @Text(120) machineName?: string;
  @Text(40) assetNo?: string;
  @Text(40) registrationNo?: string;
  @Text(120) makeModel?: string;
  @Text(40) meterReading?: string;
  @Text(40) fuelLevel?: string;
  @Text(80) operator?: string;
  @Text(500) remarks?: string;

  // Section 2
  @Text(2000) complaint?: string;

  @ApiPropertyOptional({ enum: JOB_CARD_CONDITIONS })
  @IsOptional()
  @IsIn(JOB_CARD_CONDITIONS)
  machineCondition?: string;

  @Text(40) breakdownStart?: string;
  @Text(80) reportedTo?: string;

  @ApiPropertyOptional({ type: [JobCardInspectionDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => JobCardInspectionDto)
  inspections?: JobCardInspectionDto[];

  @ApiPropertyOptional({ type: [JobCardPartDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => JobCardPartDto)
  parts?: JobCardPartDto[];

  // Section 5
  @ApiPropertyOptional({ enum: JOB_CARD_CHECKS, isArray: true })
  @IsOptional()
  @IsArray()
  @IsIn(JOB_CARD_CHECKS, { each: true })
  checks?: string[];

  @ApiPropertyOptional({ enum: JOB_CARD_RESULTS })
  @IsOptional()
  @IsIn(JOB_CARD_RESULTS)
  testResult?: string;

  @Text(1000) outstandingWork?: string;

  @ApiPropertyOptional({ enum: JOB_CARD_STATUSES })
  @IsOptional()
  @IsIn(JOB_CARD_STATUSES)
  machineStatus?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  downTimeHours?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  nextServiceDate?: string;

  @Text(40) nextServiceReading?: string;

  @ApiPropertyOptional({ type: JobCardSignOffDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => JobCardSignOffDto)
  signOff?: JobCardSignOffDto;
}
