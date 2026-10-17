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
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class SalaryComponentDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @ApiProperty()
  @IsString()
  @MaxLength(200)
  name!: string;
  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9_999_999_999.99)
  monthlyAmount!: number;
}

export class CreateOfferDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @ApiProperty()
  @IsString()
  @MaxLength(100)
  designationId!: string;
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @ApiProperty()
  @IsString()
  @MaxLength(100)
  departmentId!: string;
  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(999_999_999_999.99)
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
  @ApiProperty({ example: 6 })
  @IsInt()
  @Min(0)
  @ApiProperty({ example: 6 })
  @IsInt()
  @Max(2_147_483_647)
  probationMonths!: number;
  @ApiProperty({ example: 30 })
  @IsInt()
  @Min(0)
  @ApiProperty({ example: 30 })
  @IsInt()
  @Max(2_147_483_647)
  noticePeriodDays!: number;
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @ApiProperty()
  @IsString()
  @MaxLength(100)
  reportingManagerEmployeeId!: string;
}

export class AcceptOfferDto {
  @ApiProperty({ example: '2026-11-01' }) @IsDateString() acceptedOn!: string;
  @ApiPropertyOptional({ example: '2026-11-15' })
  @IsOptional()
  @IsDateString()
  confirmedJoiningDate?: string;
}

export class DeclineOfferDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @ApiProperty()
  @IsString()
  @MaxLength(2_000)
  declineReason!: string;
}
