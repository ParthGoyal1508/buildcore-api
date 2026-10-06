import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class ComposeBillLineDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  boqTaskItemId: string;

  @ApiProperty({
    description:
      'Measured on **this** bill. Cumulative is an aggregate the server derives — a client sending a ' +
      'running total would be sending a second copy of a figure the server already knows.',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  quantity: number;

  @ApiPropertyOptional({
    description:
      'Why this measurement goes past the BOQ scope. Required to **submit** a bill carrying an ' +
      'over-scope line, not to compose one — a measurement that cannot be entered is a measurement ' +
      'that goes in a notebook instead.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  overScopeReason?: string;
}

export class ComposeBillDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  projectId: string;

  /**
   * Omit to have it allocated: `RA-01`, `RA-02`… in sequence on this project (027).
   *
   * Was required and typed, which made the client bill number something a person invented while the
   * 023 package path was already minting one into the same column. Omission differs from an empty
   * string: `@IsOptional()` skips `undefined`, so `''` still fails `MinLength`.
   */
  @ApiPropertyOptional({ example: 'RA-01' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  billNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ example: '2026-08-21' })
  @IsDateString()
  billingDate: string;

  @ApiProperty({ type: [ComposeBillLineDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ComposeBillLineDto)
  lines: ComposeBillLineDto[];

  @ApiPropertyOptional({
    description:
      'Retention withheld by the client, as a fraction — `0.05` is 5%. **Not a project cost**: it is ' +
      'the client’s money held back and released later, so the P&L reads gross rather than net.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(1)
  retentionPercent?: number;
}

export class CertifyBillDto {
  @ApiProperty({
    description:
      'What the client certified. Kept **alongside** the billed amount, never instead of it — the ' +
      'variance is what a project manager chases, and overwriting erases the fact there was one.',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  certifiedAmount: number;
}
