import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Reversing an approval (022 FR-019).
 *
 * The reason is required by this DTO as well as by the column's docblock, and it is required for a
 * reason rather than for form: a reversal takes a quantity back out of a figure a bill may already
 * have been built from, and "why was December's measurement reduced in February" is the first
 * question anybody asks. An optional reason on a path that moves money is an empty field.
 */
export class ReverseDwrDto {
  @ApiProperty({
    example: 'double-counted CH 228+200 — measured by both crews',
    minLength: 10,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(10, {
    message:
      'Say what was wrong. A reversal moves a quantity a bill may depend on, and a one-word reason answers nobody.',
  })
  @MaxLength(2000)
  reason!: string;
}

/** Repairing a drifted counter (022 FR-039c, decision D3). */
export class RepairDoneQtyDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  boqItemIds!: string[];

  @ApiProperty({
    example: 'drift of 5.000 traced to the interrupted approval on 14 Jan',
    minLength: 10,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(10, {
    message:
      'Say what drifted and why you believe the counter is the wrong figure. A repair overwrites it.',
  })
  @MaxLength(2000)
  reason!: string;
}
