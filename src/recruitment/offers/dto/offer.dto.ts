import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class SalaryComponentDto {
  @ApiProperty() @IsString() @IsNotEmpty() name!: string;
  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  monthlyAmount!: number;
}

export class CreateOfferDto {
  @ApiProperty() @IsString() @IsNotEmpty() designationId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() departmentId!: string;
  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  offeredCtc!: number;

  @ApiProperty({ type: [SalaryComponentDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => SalaryComponentDto)
  salaryBreakup!: SalaryComponentDto[];

  @ApiProperty({ example: '2026-11-15' })
  @IsDateString()
  proposedJoiningDate!: string;
  @ApiProperty({ example: 6 }) @IsInt() @Min(0) probationMonths!: number;
  @ApiProperty({ example: 30 }) @IsInt() @Min(0) noticePeriodDays!: number;
  @ApiProperty() @IsString() @IsNotEmpty() reportingManagerEmployeeId!: string;
}

export class AcceptOfferDto {
  @ApiProperty({ example: '2026-11-01' }) @IsDateString() acceptedOn!: string;
  @ApiPropertyOptional({ example: '2026-11-15' })
  @IsOptional()
  @IsDateString()
  confirmedJoiningDate?: string;
}

export class DeclineOfferDto {
  @ApiProperty() @IsString() @IsNotEmpty() declineReason!: string;
}
